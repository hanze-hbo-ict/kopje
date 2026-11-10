// PLAN.md Phase 5 / §13 S4 (Gate 5): the runtime runs in an opaque-origin sandboxed iframe.
import { test, expect } from '@playwright/test';

async function setSource(page, text) {
  await page.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.press('Delete');
  await page.keyboard.insertText(text);
}

test('Gate 5: runtime frame cannot reach IDE DOM, storage or cookies; IDE stays responsive', async ({ page, browserName }) => {
  test.skip(browserName === 'webkit', 'WebKit does not isolate opaque-origin frames; same-origin fallback (tested below)');
  await page.goto('/');
  await expect(page.locator('#status')).toHaveAttribute('data-state', 'ready', { timeout: 120_000 });
  await page.evaluate(() => { document.cookie = 'ide=secret; SameSite=Strict'; sessionStorage.setItem('probe', 'secret'); });

  const iframe = page.locator('iframe[title="Java runtime"]');
  await expect(iframe).toHaveAttribute('sandbox', 'allow-scripts');
  const frame = page.frames().find((f) => f.url().includes('/host/runtime.html'));
  expect(frame, 'runtime frame').toBeTruthy();

  const probe = await frame.evaluate(() => {
    const attempt = (fn) => { try { return 'reachable: ' + String(fn()).slice(0, 40); } catch (e) { return 'blocked: ' + e.name; } };
    return {
      origin: self.origin,
      parentDocument: attempt(() => parent.document.title),
      parentStorage: attempt(() => parent.sessionStorage.getItem('probe')),
      parentLocation: attempt(() => parent.location.href),
      ownStorage: attempt(() => sessionStorage.length),
      ownLocalStorage: attempt(() => localStorage.length),
      cookie: attempt(() => document.cookie),
      sab: typeof SharedArrayBuffer,
    };
  });
  expect(probe.origin).toBe('null');
  expect(probe.parentDocument).toMatch(/^blocked/);
  expect(probe.parentStorage).toMatch(/^blocked/);
  expect(probe.parentLocation).toMatch(/^blocked/);
  expect(probe.ownStorage).toMatch(/^blocked/);
  expect(probe.ownLocalStorage).toMatch(/^blocked/);
  expect(probe.cookie).not.toContain('secret');
  expect(probe.sab).toBe('function');

  // The IDE stays usable while the runtime spins, and Stop tears it down.
  await setSource(page, 'package example;\n\npublic class Main {\n    public static void main(String[] args) {\n        System.out.println("spin");\n        while (true) { }\n    }\n}\n');
  await page.locator('#run').click();
  await expect(page.locator('#output')).toHaveText('spin\n', { timeout: 60_000 });
  const t0 = Date.now();
  await page.locator('#file-list button[data-path="example/Calculator.java"]').click();
  await expect(page.locator('#filename-text')).toHaveText('example/Calculator.java');
  expect(Date.now() - t0).toBeLessThan(2000);
  await page.locator('#run').click(); // Stop
  await expect(page.locator('#notes')).toHaveText('Stopped.');
  await expect(page.locator('#status')).toHaveText('Ready');
});

test('Phase 5 fallback: without isolation in the sandbox (WebKit), runtimes run same-origin and still work', async ({ page, browserName }) => {
  test.skip(browserName !== 'webkit', 'only WebKit needs the fallback');
  await page.goto('/');
  await expect(page.locator('#status')).toHaveAttribute('data-state', 'ready', { timeout: 120_000 });
  await expect(page.locator('iframe[title="Java runtime"]')).not.toHaveAttribute('sandbox', /./);
  await page.locator('#run').click();
  await page.locator('#answer').fill('4');
  await page.locator('#answer').press('Enter');
  await page.locator('#answer').fill('5');
  await page.locator('#answer').press('Enter');
  await expect(page.locator('#output')).toContainText('4 + 5 = 9', { timeout: 60_000 });
});
