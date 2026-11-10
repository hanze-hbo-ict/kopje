// Diagnostic: which Java thread stack size makes the JVM throw StackOverflowError before the
// browser's native stack limit? Run explicitly: npx playwright test stack-diag
import { test } from '@playwright/test';
for (const kb of (process.env.STACK_KB || "64,128,192,256,384").split(",").map(Number)) {
  test(`thread stack ${kb} KB`, async ({ page, browserName }) => {
    test.setTimeout(120_000);
    page.on('pageerror', (e) => console.log(`[${browserName} ${kb}KB] pageerror: ${e.message}`));
    await page.goto('/slice.html');
    await page.waitForFunction(() => window.bootMs !== undefined, null, { timeout: 120_000 });
    const src = `public class Main {
      static int depth = 0; static void f() { depth++; f(); }
      public static void main(String[] a) throws Exception {
        Thread t = new Thread(null, () -> {
          try { f(); } catch (StackOverflowError e) { System.out.println("SOE at depth " + depth); }
        }, "student", ${kb}L * 1024);
        t.start(); t.join();
        System.out.println("done");
      } }`;
    const r = await page.evaluate((src) => new Promise((resolve) => {
      const out = [];
      const timer = setTimeout(() => window.engine.stop(), 20000);
      window.engine.run({ 'Main.java': src }, 'Main', (e) => { if (e.kind === 'stdout') out.push(e.text); })
        .then((r) => { clearTimeout(timer); resolve({ status: r.status, out: out.join('').trim().replace(/\n/g, ' | ') }); });
    }), src);
    console.log(`[${browserName} ${kb}KB] ${JSON.stringify(r)}`);
  });
}
