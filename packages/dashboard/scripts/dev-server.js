#!/usr/bin/env node
// Development only: serves public/ on 127.0.0.1 without the API, so the dashboard falls back to
// its bundled sample data. The real app is served by packages/api. Usage: node scripts/dev-server.js [port]
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { publicDir } from '../src/index.js';

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8' };
const port = Number(process.argv[2] || process.env.PORT || 5178);

createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (url.pathname.startsWith('/api/')) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('no api in dev server'); return; }
    let p = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
    let file = join(publicDir, p || 'index.html');
    if (!file.startsWith(publicDir.endsWith(sep) ? publicDir : publicDir + sep)) { res.writeHead(403); res.end(); return; }
    if ((await stat(file).catch(() => null))?.isDirectory()) file = join(file, 'index.html');
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found');
  }
}).listen(port, '127.0.0.1', () => console.log(`dashboard (sample data): http://127.0.0.1:${port}/`));
