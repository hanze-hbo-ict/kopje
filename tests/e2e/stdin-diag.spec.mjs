// Diagnostic + evidence: the prebuilt fd 0 reports available()==0 forever while read() works (ADR-3).
// Run: npx playwright test stdin-diag --project=chromium
import { test } from '@playwright/test';
const PROBE = `import java.io.*;
public class Main { public static void main(String[] a) throws Exception {
  FileInputStream raw = new FileInputStream(FileDescriptor.in);
  long t = System.nanoTime(); Thread.sleep(50); System.out.println("sleep50 took ms " + (System.nanoTime() - t) / 1000000);
  for (int i = 0; i < 30; i++) { System.out.println("avail " + raw.available()); Thread.sleep(100); }
  System.out.println("read " + raw.read());
} }`;
test('stdin probe', async ({ page }) => {
  await page.goto('/slice.html');
  await page.waitForFunction(() => window.bootMs !== undefined, null, { timeout: 60_000 });
  await page.evaluate((src) => { window.ev = []; window.engine.run({ 'Main.java': src }, 'Main', (e) => window.ev.push(e)).then((r) => { window.res = r; }); }, PROBE);
  await page.waitForTimeout(1500);
  await page.evaluate(() => window.engine.sendInput('x\n'));
  await page.waitForTimeout(5000);
  const ev = await page.evaluate(() => window.ev.map((e) => e.kind === 'stdout' || e.kind === 'stderr' ? e.kind + ':' + e.text : e.kind));
  console.log(ev.join('').replace(/stdout:/g, ''));
  console.log('result', JSON.stringify(await page.evaluate(() => window.res)));
});
