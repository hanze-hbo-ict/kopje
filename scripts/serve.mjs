#!/usr/bin/env node
// Static server with the headers SharedArrayBuffer needs. Usage: node scripts/serve.mjs [dir] [port]
import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { join, resolve, extname, normalize, sep } from 'node:path';

const root = resolve(process.argv[2] || 'dist');
const port = Number(process.argv[3] || 5173);
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.wasm': 'application/wasm',
  '.data': 'application/octet-stream', '.class': 'application/java-vm', '.svg': 'image/svg+xml', '.png': 'image/png',
};
createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  let p = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
  if (p === '' ) p = 'index.html';
  const file = join(root, p);
  if (!(file + sep).startsWith(root + sep) && file !== root) { res.writeHead(403).end(); return; }
  let st;
  try { st = statSync(file); } catch { res.writeHead(404).end('not found'); return; }
  if (st.isDirectory()) { res.writeHead(404).end(); return; }
  res.writeHead(200, {
    'Content-Type': TYPES[extname(file)] || 'application/octet-stream',
    'Content-Length': st.size,
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Cache-Control': 'no-cache',
  });
  createReadStream(file).pipe(res);
}).listen(port, () => console.log(`serving ${root} on http://localhost:${port} (COOP/COEP on)`));
