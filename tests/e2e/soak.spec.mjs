// Many consecutive runs in one page: run time must not degrade (disposed runtimes must be freed).
import { test, expect } from '@playwright/test';
const HELLO = { 'Main.java': 'public class Main { public static void main(String[] a) { System.out.println("ok"); } }' };
test('12 consecutive runs do not slow down', async ({ page }) => {
  test.setTimeout(600_000);
  await page.goto('/slice.html');
  await page.waitForFunction(() => window.bootMs !== undefined, null, { timeout: 120_000 });
  const times = [];
  for (let i = 0; i < 12; i++) {
    const r = await page.evaluate((files) => {
      const t = performance.now();
      return window.engine.run(files, 'Main', () => {}).then((res) => ({ res, ms: Math.round(performance.now() - t) }));
    }, HELLO);
    expect(r.res).toMatchObject({ status: 'exit', code: 0 });
    times.push(r.ms);
    await page.waitForTimeout(2500); // let the spare boot, as a user would
  }
  console.log('run ms', times.join(' '));
  const first = Math.min(...times.slice(0, 3)), last = Math.max(...times.slice(-3));
  expect(last, `degradation: ${times.join(' ')}`).toBeLessThan(first * 3);
});
