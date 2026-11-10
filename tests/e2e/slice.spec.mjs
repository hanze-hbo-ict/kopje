// Gate 2 vertical slice against the real WASM runtime (dist/slice.html).
// Prereq: npm run build:runtime. Results/metrics go to docs/baseline.md.
import { test, expect } from '@playwright/test';

const files = (main, calc) => ({ 'example/Main.java': main, 'example/Calculator.java': calc });
const CALC = 'package example; public class Calculator { public int add(int a, int b) { return a + b; } }';
const ASK = `package example; import java.util.Scanner;
public class Main { public static void main(String[] a) { Scanner in = new Scanner(System.in);
  System.out.print("Name? "); String n = in.nextLine(); System.out.print("Age? "); String g = in.nextLine();
  System.out.println("Hello " + n + " " + g + " " + new Calculator().add(2, 3)); } }`;

async function boot(page) {
  await page.goto('/slice.html');
  await page.waitForFunction(() => window.bootMs !== undefined, null, { timeout: 180_000 });
  return page.evaluate(() => window.bootMs);
}

/** Start a run in the page; returns immediately. Events accumulate in window.ev. */
const start = (page, f, main = 'example.Main') => page.evaluate(([f, main]) => {
  window.ev = []; window.res = undefined;
  window.engine.run(f, main, (e) => window.ev.push(e)).then((r) => { window.res = r; });
}, [f, main]);
const out = (page, kind = 'stdout') => page.evaluate((k) => window.ev.filter((e) => e.kind === k).map((e) => e.text).join(''), kind);
const result = (page, ms = 120_000) => page.waitForFunction(() => window.res, null, { timeout: ms }).then((h) => h.jsonValue());

test('Gate 0/1/2: multi-file, interactive stdin, stop, clean rerun', async ({ page }) => {
  const bootMs = await boot(page);
  console.log('cold boot+warmup ms', bootMs);

  // multi-file + interactive
  let t = Date.now();
  await start(page, files(ASK, CALC));
  await expect.poll(() => out(page), { timeout: 120_000 }).toBe('Name? ');
  console.log('time to first prompt ms', Date.now() - t);
  await expect.poll(() => page.evaluate(() => window.ev.some((e) => e.kind === 'waiting-for-input'))).toBe(true);
  await page.evaluate(() => window.engine.sendInput('Ada\n'));
  await expect.poll(() => out(page)).toBe('Name? Age? ');
  await page.evaluate(() => window.engine.sendInput('36\n'));
  expect(await result(page)).toMatchObject({ status: 'exit', code: 0 });
  expect(await out(page)).toBe('Name? Age? Hello Ada 36 5\n');

  // syntax error in second file -> file-specific diagnostic, nothing runs
  await start(page, files(ASK, CALC.replace('a + b;', 'a + b')));
  const r = await result(page);
  expect(r.status).toBe('compile-error');
  expect(r.diagnostics[0]).toMatchObject({ file: 'example/Calculator.java', line: 1, severity: 'error' });

  // edited second file takes effect
  await start(page, files('package example; public class Main { public static void main(String[] a) { System.out.println(new Calculator().add(2, 3)); } }',
                          CALC.replace('a + b', 'a * b')));
  t = Date.now();
  expect(await result(page)).toMatchObject({ status: 'exit', code: 0 });
  console.log('warm compile+run ms', Date.now() - t);
  expect(await out(page)).toBe('6\n');

  // while(true) -> Stop, UI stays responsive
  await start(page, files('package example; public class Main { public static void main(String[] a) { System.out.println("spin"); while (true) {} } }', CALC));
  await expect.poll(() => out(page), { timeout: 120_000 }).toBe('spin\n');
  const before = Date.now();
  expect(await page.evaluate(() => 1 + 1)).toBe(2);              // main thread not blocked
  await page.evaluate(() => window.engine.stop());
  expect(await result(page, 5_000)).toMatchObject({ status: 'stopped' });
  console.log('stop latency ms', Date.now() - before);
  expect(await page.locator('iframe').count()).toBeLessThanOrEqual(1); // only the new spare

  // Stop while blocked in Scanner.nextLine
  await start(page, files(ASK, CALC));
  await expect.poll(() => page.evaluate(() => window.ev.some((e) => e.kind === 'waiting-for-input')), { timeout: 120_000 }).toBe(true);
  await page.evaluate(() => window.engine.stop());
  expect(await result(page, 5_000)).toMatchObject({ status: 'stopped' });

  // System.exit does not break later runs
  await start(page, files('package example; public class Main { public static void main(String[] a) { System.out.println("bye"); System.exit(3); } }', CALC));
  expect(await result(page)).toMatchObject({ status: 'exit', code: 3 });

  // uncaught exception
  await start(page, files('package example; public class Main { public static void main(String[] a) { Object o = null; o.toString(); } }', CALC));
  expect((await result(page)).code).toBe(1);
  expect(await out(page, 'stderr')).toMatch(/^Exception in thread "main" java\.lang\.NullPointerException/);

  // clean subsequent run
  await start(page, files('package example; public class Main { public static void main(String[] a) { System.out.println("clean " + new Calculator().add(1, 1)); } }', CALC));
  expect(await result(page)).toMatchObject({ status: 'exit', code: 0 });
  expect(await out(page)).toBe('clean 2\n');
});

test('excessive output is truncated with a notice', async ({ page }) => {
  await boot(page);
  await start(page, files('package example; public class Main { public static void main(String[] a) { while (true) System.out.println("xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"); } }', CALC));
  expect(await result(page)).toMatchObject({ status: 'output-limit' });
});
