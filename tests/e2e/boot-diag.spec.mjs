// Diagnostic: dumps console output and runtime events during a boot. Run explicitly:
//   npx playwright test boot-diag --project=chromium
import { test } from '@playwright/test';
test('boot diagnostics', async ({ page }) => {
  const t0 = Date.now();
  const log = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`);
  page.on('console', (m) => log(`console.${m.type()}: ${m.text().slice(0, 400)}`));
  page.on('pageerror', (e) => log('pageerror: ' + e.message));
  page.on('requestfailed', (r) => log('requestfailed: ' + r.url() + ' ' + r.failure()?.errorText));
  page.on('worker', (w) => log('worker: ' + w.url().slice(-60)));
  await page.exposeFunction('__diag', (s) => log(s));
  await page.addInitScript(() => {
    addEventListener('message', (e) => { if (e.data?.type === 'event') window.__diag?.('event ' + JSON.stringify(e.data.event).slice(0, 400)); });
  });
  await page.goto('/slice.html');
  await page.waitForFunction(() => window.bootMs !== undefined, null, { timeout: 25_000 }).catch(() => log('NOT READY'));
  log('status: ' + await page.locator('#status').textContent());
});
