// Diagnostic: boot the runtime iframe document directly (no IDE, no bundler). E2E_SERVER=public DIAG=1
// Run: npx playwright test runtime-direct --project=chromium
import { test } from '@playwright/test';
import { RUNTIME_BASE } from './runtime-path.mjs';
test('runtime boots directly', async ({ page }) => {
  const t0 = Date.now();
  const seen = [];
  await page.exposeFunction('__diag', (s) => { seen.push(s); console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`); });
  page.on('response', (r) => { if (r.status() >= 400) console.log('HTTP', r.status(), r.url()); });
  await page.addInitScript(() => addEventListener('message', (e) => { if (e.data?.type === 'event') window.__diag?.(JSON.stringify(e.data.event).slice(0, 240)); }));
  await page.goto(`${RUNTIME_BASE}/host/runtime.html`);
  await page.waitForFunction(() => false, null, { timeout: 30_000 }).catch(() => {});
});
