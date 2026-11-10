// PLAN.md §13: S1 (no attacker-chosen code via URL), S2 (CSP), S7 (framing).
import { test, expect } from '@playwright/test';
import { RUNTIME_BASE } from './runtime-path.mjs';

const ATTACKER = 'http://127.0.0.1:5392/';   // a different origin; nothing listens there

test('S2/S7: security headers on pages, runtime document and assets', async ({ request }) => {
  for (const path of ['/', `${RUNTIME_BASE}/host/runtime.html`, `${RUNTIME_BASE}/host/runtime-host.js`, `${RUNTIME_BASE}/javabox/javabox-direct.wasm.gz`]) {
    const res = await request.get(path);
    expect(res.status(), path).toBe(200);
    const h = res.headers();
    expect(h['cross-origin-opener-policy'], path).toBe('same-origin');
    expect(h['cross-origin-embedder-policy'], path).toBe('require-corp');
    expect(h['content-security-policy'], path).toContain("connect-src 'self'");
    expect(h['content-security-policy'], path).toContain("frame-ancestors 'self'");
    expect(h['content-security-policy'], path).not.toContain('unsafe-inline');
    expect(h['x-frame-options'], path).toBe('SAMEORIGIN');
    expect(h['x-content-type-options'], path).toBe('nosniff');
  }
});

test('S2: the page cannot reach other origins; the IDE still works under the CSP', async ({ page }) => {
  const violations = [];
  page.on('console', (m) => { if (/Content Security Policy|Content-Security-Policy|CSP/i.test(m.text())) violations.push(m.text()); });
  await page.goto('/');
  await expect(page.locator('#status')).toHaveAttribute('data-state', 'ready', { timeout: 120_000 });
  const blocked = await page.evaluate(async (url) => {
    try { await fetch(url, { mode: 'no-cors' }); return false; } catch { return true; }
  }, 'https://example.com/');
  expect(blocked, 'fetch to another origin must fail').toBe(true);
  // A full interactive run under the CSP (editor styles, Workers, WASM, runtime iframe).
  await page.locator('#run').click();
  await page.locator('#answer').fill('1');
  await page.locator('#answer').press('Enter');
  await page.locator('#answer').fill('2');
  await page.locator('#answer').press('Enter');
  await expect(page.locator('#output')).toContainText('1 + 2 = 3', { timeout: 60_000 });
  // Expected: our own fetch probe above, and Firefox's informational note that it ignores
  // X-Frame-Options when frame-ancestors is present (XFO is kept for older browsers).
  const unexpected = violations.filter((v) => !v.includes('example.com') && !/Ignoring .x-frame-options./i.test(v));
  expect(unexpected, violations.join('\n')).toEqual([]);
});

test('S1: runtime URL parameters cannot choose code, classes or JVM options', async ({ page }) => {
  const foreign = [];
  page.on('request', (r) => { if (r.url().startsWith(ATTACKER)) foreign.push(r.url()); });
  const events = [];
  await page.exposeFunction('__ev', (e) => events.push(e));
  // Only events from the injected frame count (the IDE boots its own spare runtime too).
  await page.addInitScript(() => addEventListener('message', (e) => {
    const probe = document.getElementById('probe');
    if (probe && e.source === probe.contentWindow && e.data?.type === 'event') window.__ev(e.data.event);
  }));
  const q = new URLSearchParams({ runtime: ATTACKER, driver: ATTACKER, jvmArg: '-version', outputCap: '9999999999999' });
  // The runtime document posts to its parent; load it inside a same-origin wrapper page.
  await page.goto('/');
  await page.evaluate((src) => {
    const f = document.createElement('iframe');
    f.id = 'probe';
    f.src = src;
    document.body.append(f);
  }, `${RUNTIME_BASE}/host/runtime.html?${q}`);
  await expect.poll(() => events.some((e) => e.kind === 'ready'), { timeout: 120_000 }).toBe(true);
  expect(foreign, 'no request may go to the attacker origin').toEqual([]);
});
