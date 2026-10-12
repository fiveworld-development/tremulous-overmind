#!/usr/bin/env node
// Builds the fully static web release into build/web:
//   index.html (branded shell), tremulous.js (patched), tremulous.wasm,
//   assets/manifest.json + assets/<crc32>-<name>.pk3 (content-addressed, cache forever)
//
// usage: node scripts/build-web.js --stack <tremulous_web checkout> [--client <dir with tremulous.js/.wasm>]
//                                  [--out build/web] [--base /]
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1]]);
    return acc;
}, []));
const root = path.resolve(__dirname, '..');
const stack = path.resolve(args.stack || path.join(root, 'src/tremulous_web'));
const out = path.resolve(args.out || path.join(root, 'build/web'));
const base = (args.base || '/').replace(/\/?$/, '/');

// --client: our own CI build (patched engine); falls back to the upstream prebuilt client
const clientBin = path.resolve(args.client || path.join(stack, 'tremulous_client_content/client_node/bin'));
const assetDirs = [path.join(stack, 'tremulous_assets'), path.resolve(args.pk3 || path.join(root, 'build/pk3'))];

// --- crc32 (same as buffer-crc32 used by the upstream content server) ---
const CRC_TABLE = new Uint32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
});
function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

// --- minimal zip writer (deflate), enough for pk3s ---
function zipDir(dir) {
    const files = [];
    (function walk(d) {
        for (const n of fs.readdirSync(d).sort()) {
            const p = path.join(d, n);
            if (fs.statSync(p).isDirectory()) walk(p); else files.push(p);
        }
    })(dir);
    const local = [], central = [];
    let offset = 0;
    for (const f of files) {
        const name = Buffer.from(path.relative(dir, f).split(path.sep).join('/'));
        const data = fs.readFileSync(f), comp = zlib.deflateRawSync(data, { level: 9 }), crc = crc32(data);
        const h = Buffer.alloc(30);
        h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(8, 8);
        h.writeUInt16LE(0x21, 12); // fixed DOS date 1980-01-01, time 00:00 -> reproducible paks
        h.writeUInt32LE(crc, 14); h.writeUInt32LE(comp.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(name.length, 26);
        const c = Buffer.alloc(46);
        c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(8, 10);
        c.writeUInt16LE(0x21, 14);
        c.writeUInt32LE(crc, 16); c.writeUInt32LE(comp.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(name.length, 28);
        c.writeUInt32LE(offset, 42);
        local.push(h, name, comp); central.push(c, name);
        offset += 30 + name.length + comp.length;
    }
    const cd = Buffer.concat(central), end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
    end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
    return Buffer.concat([...local, cd, end]);
}

function main() {
    fs.rmSync(out, { recursive: true, force: true });
    fs.mkdirSync(path.join(out, 'assets'), { recursive: true });

    // 0. our own paks (branding) from source folders
    fs.mkdirSync(assetDirs[1], { recursive: true });
    fs.writeFileSync(path.join(assetDirs[1], 'zz-webnova360.pk3'), zipDir(path.join(root, 'branding/pk3')));

    // 1. pk3 assets, content-addressed
    const manifest = [];
    const ours = new Set(); // pk3s from build/pk3 get added to the engine's preload list
    for (const dir of assetDirs) {
        if (!fs.existsSync(dir)) continue;
        for (const name of fs.readdirSync(dir).filter(n => n.endsWith('.pk3')).sort()) {
            const data = fs.readFileSync(path.join(dir, name));
            if (data.length < 1024 && data.toString('utf8', 0, 40).startsWith('version https://git-lfs')) {
                throw new Error(`${name} is a git-lfs pointer, run "git lfs pull" first`);
            }
            const checksum = crc32(data);
            const compressed = zlib.gzipSync(data).length;
            fs.copyFileSync(path.join(dir, name), path.join(out, 'assets', `${checksum}-${name}`));
            manifest.push({ name, compressed, checksum });
            if (dir === assetDirs[1]) ours.add(name);
        }
    }
    fs.writeFileSync(path.join(out, 'assets/manifest.json'), JSON.stringify(manifest));

    // 2. engine: content-addressed wasm (a cached wasm from another build fails to link
    // against a newer loader), patch the built-in asset list so extra pk3s get loaded
    const wasm = fs.readFileSync(path.join(clientBin, 'tremulous.wasm'));
    const wasmName = `tremulous.${crc32(wasm).toString(36)}.wasm`;
    fs.writeFileSync(path.join(out, wasmName), wasm);
    let js = fs.readFileSync(path.join(clientBin, 'tremulous.js'), 'utf8');
    if (!js.includes("'tremulous.wasm'")) throw new Error('wasm file name not found in tremulous.js');
    js = js.replaceAll("'tremulous.wasm'", `'${wasmName}'`);
    const anchor = /(\{\s*src:"map-base-a51_b2\.pk3",\s*dest:"gpp\/map-base-a51_b2\.pk3",\s*checksum:\d+,\s*\})/;
    if (!anchor.test(js)) throw new Error('asset list anchor not found in tremulous.js');
    const extra = manifest
        .filter(e => ours.has(e.name) && !js.includes(`src:"${e.name}"`))
        .map(e => `{src:"${e.name}",dest:"gpp/${e.name}",checksum:${e.checksum},}`);
    js = js.replace(anchor, `$1${extra.map(e => ',' + e).join('')}`);
    fs.writeFileSync(path.join(out, 'tremulous.js'), js);

    // 3. pages
    const engineVer = crc32(Buffer.from(js)).toString(36);
    const web = path.join(root, 'web');
    for (const f of fs.readdirSync(web)) {
        const src = path.join(web, f);
        if (fs.statSync(src).isDirectory()) { fs.cpSync(src, path.join(out, f), { recursive: true }); continue; }
        let text = fs.readFileSync(src);
        if (/\.(html|js|css|txt|xml|json|webmanifest)$/.test(f)) {
            text = text.toString('utf8').replaceAll('%BASE%', base).replaceAll('%ENGINE_VER%', engineVer);
        }
        fs.writeFileSync(path.join(out, f), text);
    }

    // 4. cache busting: page-referenced css/js get ?v=<crc32 of the built file>
    const index = path.join(out, 'index.html');
    const page = fs.readFileSync(index, 'utf8').replace(
        /((?:href|src)=")([^"?#]+\.(?:css|js))"/g,
        (m, pre, url) => {
            if (!url.startsWith(base)) return m;
            const file = path.join(out, url.slice(base.length));
            return fs.existsSync(file) ? `${pre}${url}?v=${crc32(fs.readFileSync(file)).toString(36)}"` : m;
        });
    fs.writeFileSync(index, page);

    console.log(`built ${out}`);
    console.log(`  ${manifest.length} pk3 (${extra.length} added to engine list: ${extra.length ? manifest.filter(e => extra.some(x => x.includes(e.name))).map(e => e.name).join(', ') : '-'})`);
}

main();
