#!/usr/bin/env node
// Minimal static server for local testing of build/web (production uses nginx).
// usage: node scripts/dev-server.js [port] [dir]
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const port = +process.argv[2] || 8080;
const dir = path.resolve(process.argv[3] || path.join(__dirname, '../build/web'));
const types = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.wasm': 'application/wasm',
    '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png',
    '.webp': 'image/webp', '.ico': 'image/x-icon', '.pk3': 'application/octet-stream',
    '.webmanifest': 'application/manifest+json', '.txt': 'text/plain', '.xml': 'application/xml',
};

http.createServer((req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0]);
    let file = path.join(dir, path.normalize(url).replace(/^([/\\])+/, ''));
    if (!file.startsWith(dir)) { res.writeHead(403).end(); return; }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(404).end('not found'); return; }
        res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
        res.end(data);
    });
}).listen(port, () => console.log(`serving ${dir} on http://localhost:${port}`));
