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
  'Cross-Origin-Resource-Policy': 'same-origin',
};

export const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",   // WASM compilation; no eval, no inline scripts
  "worker-src 'self'",                       // Emscripten pthread Workers
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
  'Content-Security-Policy': CSP,
  'X-Frame-Options': 'SAMEORIGIN',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), usb=(), serial=(), bluetooth=()',
};

/** Netlify / Cloudflare Pages `_headers` file content. */
export function headersFile() {
  return ['/*', ...Object.entries(SECURITY_HEADERS).map(([k, v]) => `  ${k}: ${v}`)].join('\n') + '\n';
}
