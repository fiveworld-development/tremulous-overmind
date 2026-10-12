#!/usr/bin/env node
// Converts an uncompressed or RLE truecolor TGA (as found in Tremulous pk3s) to PNG.
// usage: node scripts/tga2png.js in.tga out.png
'use strict';
const fs = require('fs');
const zlib = require('zlib');

function readTga(buf) {
    const idLen = buf[0], type = buf[2], w = buf.readUInt16LE(12), h = buf.readUInt16LE(14);
    const bpp = buf[16] >> 3, desc = buf[17], topDown = (desc & 0x20) !== 0;
    if (type !== 2 && type !== 10) throw new Error(`unsupported TGA type ${type}`);
    const px = Buffer.alloc(w * h * 4);
    let p = 18 + idLen + (buf[1] ? buf.readUInt16LE(5) * (buf[7] >> 3) : 0);
    let i = 0;
    const put = (b, g, r, a) => { px[i++] = r; px[i++] = g; px[i++] = b; px[i++] = a; };
    const read = () => { const v = [buf[p], buf[p + 1], buf[p + 2], bpp === 4 ? buf[p + 3] : 255]; p += bpp; return v; };
    while (i < px.length) {
        if (type === 2) { put(...read()); continue; }
        const hdr = buf[p++], n = (hdr & 0x7f) + 1;
        if (hdr & 0x80) { const v = read(); for (let k = 0; k < n; k++) put(...v); }
        else for (let k = 0; k < n; k++) put(...read());
    }
    if (!topDown) { // flip to top-down rows
        const row = w * 4, tmp = Buffer.alloc(row);
        for (let y = 0; y < h >> 1; y++) {
            const a = y * row, b = (h - 1 - y) * row;
            px.copy(tmp, 0, a, a + row); px.copy(px, a, b, b + row); tmp.copy(px, b);
        }
    }
    return { w, h, px };
}

function crc32(buf) {
    let c = ~0;
    for (const byte of buf) { c ^= byte; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; }
    return ~c >>> 0;
}
function chunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
}
function writePng({ w, h, px }) {
    const raw = Buffer.alloc((w * 4 + 1) * h);
    for (let y = 0; y < h; y++) px.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
        chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const [, , input, output] = process.argv;
const img = readTga(fs.readFileSync(input));
fs.writeFileSync(output, writePng(img));
console.log(`${output}: ${img.w}x${img.h}`);
