// PLAN.md §14 E7: Java behaviour that matters in exams, asserted on exact output.
import { test, expect } from '@playwright/test';

async function boot(page) {
  await page.goto('/slice.html');
  await page.waitForFunction(() => window.bootMs !== undefined, null, { timeout: 120_000 });
}

/** Run one program; `inputs` are sent one at a time, each when the program waits for input. */
function run(page, source, inputs = []) {
  return page.evaluate(([src, inputs]) => new Promise((resolve) => {
    const out = [], err = [], ev = [];
    let next = 0;
    window.engine.run({ 'Main.java': src }, 'Main', (e) => {
      ev.push(e.kind);
      if (e.kind === 'stdout') out.push(e.text);
      if (e.kind === 'stderr') err.push(e.text);
      if (e.kind === 'waiting-for-input') {
        if (next < inputs.length) window.engine.sendInput(inputs[next++]);
        else window.engine.sendEof();
      }
    }).then((r) => resolve({ ...r, out: out.join(''), err: err.join('') }));
  }), [source, inputs]);
}

test('UTF-8 output and input, round trip', async ({ page }) => {
  await boot(page);
  const r = await run(page, `import java.util.Scanner;
public class Main { public static void main(String[] a) {
  System.out.println("café € ñ ü 日本 😀");
  System.err.println("fout: één");
  Scanner in = new Scanner(System.in);
  String s = in.nextLine();
  System.out.println("[" + s + "] " + s.length() + " " + s.codePointCount(0, s.length()));
} }`, ['Zoë €5 😀\n']);
  expect(r).toMatchObject({ status: 'exit', code: 0 });
  expect(r.out).toBe('café € ñ ü 日本 😀\n[Zoë €5 😀] 9 8\n');
  expect(r.err).toBe('fout: één\n');
});

test('Scanner: nextInt then nextLine keeps the leftover newline (like a real JVM)', async ({ page }) => {
  await boot(page);
  const r = await run(page, `import java.util.Scanner;
public class Main { public static void main(String[] a) {
  Scanner in = new Scanner(System.in);
  System.out.print("Age: ");
  int age = in.nextInt();
  String rest = in.nextLine();
  System.out.print("Name: ");
  String name = in.nextLine();
  System.out.println(age + "|" + rest + "|" + name);
  System.out.print("Two numbers: ");
  int x = in.nextInt(), y = in.nextInt();
  System.out.println(x + y);
  System.out.println(in.hasNextLine());
} }`, ['42\n', 'Ada\n', '3 4\n']);
  expect(r).toMatchObject({ status: 'exit', code: 0 });
  // The newline after "3 4" is still unread: an empty line remains, as on a real JVM.
  expect(r.out).toBe('Age: Name: 42||Ada\nTwo numbers: 7\ntrue\n');
});

test('empty lines, InputMismatchException, BufferedReader', async ({ page }) => {
  await boot(page);
  const empty = await run(page, `import java.io.*;
public class Main { public static void main(String[] a) throws IOException {
  BufferedReader r = new BufferedReader(new InputStreamReader(System.in));
  String l; int n = 0;
  while ((l = r.readLine()) != null) System.out.println(++n + ":[" + l + "]");
} }`, ['\n', 'x\n', '\n']);
  expect(empty.out).toBe('1:[]\n2:[x]\n3:[]\n');
  const bad = await run(page, `import java.util.Scanner;
public class Main { public static void main(String[] a) { new Scanner(System.in).nextInt(); } }`, ['abc\n']);
  expect(bad).toMatchObject({ status: 'exit', code: 1 });
  expect(bad.err).toMatch(/^Exception in thread "main" java\.util\.InputMismatchException/);
  expect(bad.err).toContain('at Main.main(Main.java:2)');
});

test('exception with cause, custom exception, stack depth', async ({ page }) => {
  await boot(page);
  const r = await run(page, `public class Main {
  static class BankException extends Exception { BankException(String m, Throwable c) { super(m, c); } }
  static void withdraw(int amount) throws BankException {
    try { if (amount > 10) throw new IllegalStateException("saldo te laag"); }
    catch (IllegalStateException e) { throw new BankException("opname mislukt", e); }
  }
  static int depth(int n) { return n == 0 ? 0 : 1 + depth(n - 1); }
  public static void main(String[] args) throws Exception {
    System.out.println(depth(200));
    withdraw(50);
  }
}`);
  expect(r).toMatchObject({ status: 'exit', code: 1 });
  expect(r.out).toBe('200\n');
  expect(r.err).toMatch(/^Exception in thread "main" Main\$BankException: opname mislukt\n\tat Main\.withdraw\(Main\.java:5\)\n\tat Main\.main\(Main\.java:10\)\nCaused by: java\.lang\.IllegalStateException: saldo te laag\n\tat Main\.withdraw\(Main\.java:4\)\n/);
});

test('infinite recursion ends with a StackOverflowError, never a hang', async ({ page, browserName }) => {
  await boot(page);
  const r = await run(page, 'public class Main { static int f(int n) { return f(n + 1) + 1; } public static void main(String[] a) { f(0); } }');
  if (browserName === 'webkit') {
    // WebKit's worker stack is smaller than the JVM's check: the host reports it instead.
    expect(r.status).toBe('error');
    expect(r.message).toContain('StackOverflowError');
  } else {
    expect(r).toMatchObject({ status: 'exit', code: 1 });
    expect(r.err).toMatch(/^Exception in thread "main" java\.lang\.StackOverflowError/);
  }
});

test('recursion depth: 600 nested calls work; SOE is catchable', async ({ page, browserName }) => {
  test.skip(browserName === 'webkit', 'WebKit worker stacks allow far fewer frames (see limitations)');
  await boot(page);
  const r = await run(page, `public class Main {
  static long sum(int n) { return n == 0 ? 0 : n + sum(n - 1); }
  static int d = 0; static void f() { d++; f(); }
  public static void main(String[] a) {
    System.out.println(sum(600));
    try { f(); } catch (StackOverflowError e) { System.out.println("caught after " + (d > 400)); }
  } }`);
  expect(r).toMatchObject({ status: 'exit', code: 0 });
  expect(r.out).toBe('180300\ncaught after true\n');
});

test('long output is complete and ordered; printf, String.format, Locale', async ({ page }) => {
  await boot(page);
  const r = await run(page, `public class Main { public static void main(String[] a) {
  StringBuilder sb = new StringBuilder();
  for (int i = 1; i <= 5000; i++) System.out.println("line " + i);
  System.out.printf("%.2f %5d %s%n", Math.PI, 42, "x");
  System.out.println(String.format("%,d", 1234567));
  System.out.println(java.util.Locale.getDefault());
} }`);
  expect(r).toMatchObject({ status: 'exit', code: 0 });
  const lines = r.out.split('\n');
  expect(lines.slice(0, 5000)).toEqual(Array.from({ length: 5000 }, (_, i) => `line ${i + 1}`));
  expect(lines.slice(5000)).toEqual(['3.14    42 x', '1,234,567', 'en_US', '']);
});
