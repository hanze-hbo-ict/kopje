#!/usr/bin/env node
// Static server with the production headers (security-headers.mjs): security, COOP/COEP,
// and E5 caching (immutable /assets and /runtime, revalidated HTML, ETag + 304).
// Usage: node scripts/serve.mjs [dir] [port]
import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { join, resolve, extname, normalize, sep } from 'node:path';
import { SECURITY_HEADERS, RUNTIME_EXTRA, isRuntimePath, cacheControlFor } from '../security-headers.mjs';

const root = resolve(process.argv[2] || 'dist');
const port = Number(process.argv[3] || 5391);
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.wasm': 'application/wasm', '.txt': 'text/plain; charset=utf-8',
  '.data': 'application/octet-stream', '.gz': 'application/gzip', '.class': 'application/java-vm', '.svg': 'image/svg+xml', '.png': 'image/png',
};
createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  let p = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
  if (p === '' || p === '.') p = 'index.html';
  const file = join(root, p);
  if (!(file + sep).startsWith(root + sep) && file !== root) { res.writeHead(403).end(); return; }
  let st;
  try { st = statSync(file); } catch { res.writeHead(404).end('not found'); return; }
  if (st.isDirectory()) { res.writeHead(404).end(); return; }
  const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  const headers = { ...SECURITY_HEADERS, 'Cache-Control': cacheControlFor(url.pathname), ETag: etag };
  if (isRuntimePath(url.pathname)) {
    // Two CSP headers are both enforced; node's http joins array values into separate lines.
    headers['Content-Security-Policy'] = [SECURITY_HEADERS['Content-Security-Policy'], RUNTIME_EXTRA['Content-Security-Policy']];
    headers['Cross-Origin-Resource-Policy'] = RUNTIME_EXTRA['Cross-Origin-Resource-Policy'];
    headers['Access-Control-Allow-Origin'] = RUNTIME_EXTRA['Access-Control-Allow-Origin'];
  }
  if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers).end(); return; }
  res.writeHead(200, { ...headers, 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Content-Length': st.size });
  if (req.method === 'HEAD') { res.end(); return; }
  createReadStream(file).pipe(res);
}).listen(port, '127.0.0.1', () => console.log(`serving ${root} on http://localhost:${port} (production headers)`));
