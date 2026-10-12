#!/usr/bin/env node
// Minimal static server for local testing of build/web (production uses nginx).
// Websockets on /ws/<n> are tunnelled to the live game servers, so a locally built
// client can be tried against the real servers before it is deployed.
// usage: node scripts/dev-server.js [port] [dir] [upstream host]
'use strict';
const http = require('http');
const tls = require('tls');
const fs = require('fs');
const path = require('path');

const port = +process.argv[2] || 8080;
const dir = path.resolve(process.argv[3] || path.join(__dirname, '../build/web'));
const upstream = process.argv[4] || 'webnova360.com';
const upstreamBase = '/play-tremulous/';
const types = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.wasm': 'application/wasm',
    '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png',
    '.webp': 'image/webp', '.ico': 'image/x-icon', '.pk3': 'application/octet-stream',
    '.webmanifest': 'application/manifest+json', '.txt': 'text/plain', '.xml': 'application/xml',
};

const server = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0]);
    let file = path.join(dir, path.normalize(url).replace(/^([/\\])+/, ''));
    if (!file.startsWith(dir)) { res.writeHead(403).end(); return; }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(404).end('not found'); return; }
        res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
        res.end(data);
    });
});

// raw upgrade tunnel: rewrite the request line and Host, then pipe bytes both ways
server.on('upgrade', (req, socket, head) => {
    const m = /^\/ws\/([12])$/.exec(req.url);
    if (!m) { socket.destroy(); return; }
    const up = tls.connect(443, upstream, { servername: upstream }, () => {
        const headers = Object.entries(req.headers)
            .filter(([k]) => !/^(host|origin)$/i.test(k))
            .map(([k, v]) => `${k}: ${v}`);
        up.write(`GET ${upstreamBase}ws/${m[1]} HTTP/1.1\r\nHost: ${upstream}\r\nOrigin: https://${upstream}\r\n` +
            headers.join('\r\n') + '\r\n\r\n');
        if (head && head.length) up.write(head);
        socket.pipe(up).pipe(socket);
    });
    const close = () => { socket.destroy(); up.destroy(); };
    up.on('error', close);
    socket.on('error', close);
});

server.listen(port, () => console.log(`serving ${dir} on http://localhost:${port} (ws -> ${upstream})`));
