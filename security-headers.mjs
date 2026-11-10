// Single source of truth for response headers (PLAN.md §13 S2, S7).
// Used by vite.config.ts (dev/preview), scripts/serve.mjs, and the generated dist/_headers.
//
// One header set for every path, on purpose: static hosts (Netlify, Cloudflare Pages) combine
// headers from all matching `_headers` rules, and two CSPs combine to the strictest, which would
// block our own runtime iframe. Same-origin framing is not a clickjacking threat, so
// `frame-ancestors 'self'` everywhere is both safe and robust.

export const ISOLATION = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',   // SharedArrayBuffer for JavaBox pthreads
};
// CORP: same-origin for the app; cross-origin for /runtime/*, because the sandboxed runtime
// frame has an opaque origin and Firefox requires CORP on its document and script under COEP.
const CORP_APP = { 'Cross-Origin-Resource-Policy': 'same-origin' };

export const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval' blob:", // WASM; blob: for the runtime module in the sandbox
  "worker-src 'self' blob:",                 // Emscripten pthread Workers (Blob in the sandboxed runtime)
  "connect-src 'self'",                      // blocks fetch/XHR/WebSocket egress (also S3)
  "img-src 'self' data:",
  "style-src 'self'",
  "font-src 'self'",
  "frame-src 'self'",                        // the runtime iframe only
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'self'",                  // other sites cannot frame us (S7)
].join('; ');

export const SECURITY_HEADERS = {
  ...ISOLATION,
  ...CORP_APP,
  'Content-Security-Policy': CSP,
  'X-Frame-Options': 'SAMEORIGIN',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), usb=(), serial=(), bluetooth=()',
};

// E5 caching. Hashed assets and the content-versioned runtime never change at a given URL;
// HTML is always revalidated so a new deployment is picked up.
export const IMMUTABLE = 'public, max-age=31536000, immutable';
export const REVALIDATE = 'no-cache';

/** Cache-Control for a URL path. */
export function cacheControlFor(pathname) {
  return /^\/(assets|runtime)\//.test(pathname) ? IMMUTABLE : REVALIDATE;
}

/** Extra headers for /runtime/*: the sandboxed runtime frame (opaque origin) loads its document
 *  and script cross-origin, and must not reach the network at all. A second CSP is enforced in
 *  addition to the first, so it can only tighten. */
export const RUNTIME_EXTRA = {
  'Cross-Origin-Resource-Policy': 'cross-origin',
  'Access-Control-Allow-Origin': '*',   // module scripts are CORS requests; these files are public
  'Content-Security-Policy': "connect-src 'none'",
};
export const isRuntimePath = (pathname) => /^\/runtime\//.test(pathname);

/** Netlify / Cloudflare Pages `_headers` file content. Cache rules use paths that do not
 *  overlap, because hosts combine headers from every matching rule. */
export function headersFile() {
  const block = (path, headers) => [path, ...Object.entries(headers).map(([k, v]) => `  ${k}: ${v}`)].join('\n');
  return [
    block('/*', { ...ISOLATION, ...Object.fromEntries(Object.entries(SECURITY_HEADERS).filter(([k]) => k !== 'Cross-Origin-Resource-Policy')) }),
    block('/assets/*', { 'Cache-Control': IMMUTABLE, ...CORP_APP }),
    block('/runtime/*', { 'Cache-Control': IMMUTABLE, ...RUNTIME_EXTRA }),
    block('/', { 'Cache-Control': REVALIDATE, ...CORP_APP }),
    block('/index.html', { 'Cache-Control': REVALIDATE, ...CORP_APP }),
  ].join('\n\n') + '\n';
}
