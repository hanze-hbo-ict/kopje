/**
 * Facts about why this page may lack cross-origin isolation, for the "Java could not start"
 * message. It reports what it measured and does not guess the cause: a proxy that strips
 * headers, plain HTTP, a foreign parent frame and a browser without isolation support all
 * end in the same missing SharedArrayBuffer.
 */
export async function isolationReport(): Promise<string> {
  const yesNo = (b: boolean) => (b ? 'yes' : 'no');
  const lines = [
    `secure context: ${yesNo(isSecureContext)} (${location.protocol}//${location.host})`,
    `cross-origin isolated: ${yesNo(crossOriginIsolated)}`,
    `SharedArrayBuffer: ${typeof SharedArrayBuffer === 'function' ? 'available' : 'unavailable'}`,
    `in a frame: ${describeFraming()}`,
    `service workers: ${'serviceWorker' in navigator ? 'available' : 'unavailable'}`,
  ];
  // The headers of a fresh request for this page, as they reach the browser (after any proxy).
  try {
    const res = await fetch(location.href, { cache: 'no-store', credentials: 'omit' });
    for (const name of ['Cross-Origin-Opener-Policy', 'Cross-Origin-Embedder-Policy', 'Content-Security-Policy']) {
      const value = res.headers.get(name);
      lines.push(`${name} received: ${value === null ? '(none)' : name === 'Content-Security-Policy' ? 'yes' : value}`);
    }
  } catch (err) {
    lines.push(`response headers: could not re-fetch this page (${(err as Error).message})`);
  }
  lines.push(`browser: ${navigator.userAgent}`);
  return lines.map((l) => '  ' + l).join('\n');
}

function describeFraming(): string {
  let framed: boolean;
  try { framed = window.top !== window.self; } catch { framed = true; }
  if (!framed) return 'no';
  const ancestors = (location as Location & { ancestorOrigins?: DOMStringList }).ancestorOrigins;
  return ancestors?.length ? `yes, inside ${Array.from(ancestors).join(' < ')}` : 'yes';
}
