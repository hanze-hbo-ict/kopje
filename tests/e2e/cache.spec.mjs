// PLAN.md §14 E5: immutable runtime/assets, revalidated HTML, small repeat loads.
import { test, expect } from '@playwright/test';
import { RUNTIME_BASE } from './runtime-path.mjs';

test('E5: cache headers', async ({ request }) => {
  const html = await request.get('/');
  expect(html.headers()['cache-control']).toBe('no-cache');
  for (const p of [`${RUNTIME_BASE}/javabox/javabox-direct.data.gz`, `${RUNTIME_BASE}/javabox/javabox-direct.wasm.gz`, `${RUNTIME_BASE}/host/runtime.html`]) {
    const r = await request.head(p);
    expect(r.status(), p).toBe(200);
    expect(r.headers()['cache-control'], p).toBe('public, max-age=31536000, immutable');
  }
});

test('E5: a reload transfers < 100 KB and still boots', async ({ browserName, playwright }, testInfo) => {
  test.skip(browserName !== 'chromium', 'transfer sizes via the Chrome DevTools protocol');
  // A persistent profile has a disk cache like a normal browser; Playwright's default
  // in-memory context cache skips large entries such as the 10 MB runtime data.
  const ctx = await playwright.chromium.launchPersistentContext(testInfo.outputPath('profile'), { baseURL: testInfo.project.use.baseURL });
  try {
    const page = ctx.pages()[0] ?? await ctx.newPage();
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Network.enable');
    let bytes = 0;
    cdp.on('Network.loadingFinished', (e) => { bytes += e.encodedDataLength; });
    const ready = () => expect(page.locator('#status')).toHaveAttribute('data-state', 'ready', { timeout: 120_000 });
    await page.goto('/');
    await ready();
    const first = bytes;
    bytes = 0;
    await page.reload();
    await ready();
    console.log(`first load ${(first / 1e6).toFixed(2)} MB, reload ${(bytes / 1e3).toFixed(1)} KB`);
    expect(first).toBeGreaterThan(5e6);   // the runtime came over the network the first time
    expect(bytes).toBeLessThan(100_000);
  } finally {
    await ctx.close();
  }
});
