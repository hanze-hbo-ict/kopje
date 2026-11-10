// Diagnostic: max depth of typical recursive methods per browser. Run explicitly.
import { test } from '@playwright/test';
test('typical recursion limits', async ({ page, browserName }) => {
  test.setTimeout(200_000);
  await page.goto('/slice.html');
  await page.waitForFunction(() => window.bootMs !== undefined, null, { timeout: 120_000 });
  const probe = async (label, body) => page.evaluate(([label, body]) => new Promise((resolve) => {
    const out = [];
    const timer = setTimeout(() => window.engine.stop(), 30000);
    const src = `public class Main { static int d = 0; ${body}
      public static void main(String[] a) { try { go(); } catch (StackOverflowError e) { System.out.println("${label}: SOE at " + d); } } }`;
    window.engine.run({ 'Main.java': src }, 'Main', (e) => { if (e.kind === 'stdout') out.push(e.text.trim()); })
      .then((r) => { clearTimeout(timer); resolve(out.join(' ') || `${label}: ${r.status} ${r.message ?? ''}`); });
  }), [label, body]);
  console.log(browserName, await probe('empty', 'static void go() { d++; go(); }'));
  console.log(browserName, await probe('sum(long)', 'static long go() { d++; long x = d; return x + go(); }'));
  console.log(browserName, await probe('fib-like 3 locals', 'static int go() { d++; int a = d, b = a * 2, c = a + b; return c + go(); }'));
  console.log(browserName, await probe('string', 'static String go() { d++; String s = "n" + d; return s + go(); }'));
});
