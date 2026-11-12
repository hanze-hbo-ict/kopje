import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findMains } from '../../src/project/mains.ts';
import { parseArgs } from '../../src/project/args.ts';

const names = (path, src) => findMains(path, src).map((m) => m.className);

test('finds the classic main and its variants', () => {
  assert.deepEqual(names('Main.java', 'public class Main { public static void main(String[] args) {} }'), ['Main']);
  assert.deepEqual(names('a/B.java', 'package a; class B { static public void main(final String... xs) {} }'), ['a.B']);
  assert.deepEqual(names('a/B.java', 'package a; class B { public static void main(java.lang.String args[]) {} }'), ['a.B']);
  assert.deepEqual(names('B.java', 'class B { @SuppressWarnings("x") public static void main(@Deprecated String[] a) {} }'), ['B']);
});

test('rejects what the JDK 21 launcher would not start', () => {
  for (const body of [
    'static void main(String[] a) {}',             // not public
    'public void main(String[] a) {}',             // instance main (JDK 21 preview only)
    'public static int main(String[] a) {}',
    'public static void main() {}',
    'public static void main(String[] a, int b) {}',
    'public static void main(int[] a) {}',
  ]) assert.deepEqual(names('M.java', `public class M { ${body} }`), [], body);
});

test('ignores comments, strings, text blocks, anonymous and local classes', () => {
  const src = `package p;
// public class X { public static void main(String[] a) {} }
/* class Y { public static void main(String[] a) {} } */
public class M {
  String s = "class Z { public static void main(String[] a) {";
  String t = """
      class Q { public static void main(String[] a) { }
      """;
  char c = '{';
  void f() {
    Object o = new Object() { public static void main(String[] a) {} };
    class Local { public static void main(String[] a) {} }
    Class<?> k = M.class;
  }
}`;
  assert.deepEqual(names('p/M.java', src), []);
});

test('nested types, records, enums, interfaces and several top-level classes', () => {
  const src = `package shop;
public class Main {
  static class Inner { public static void main(String[] a) {} }
  record P(int x) { public static void main(String[] a) {} }
  enum E { A { void f() {} }, B; public static void main(String[] a) {} }
  interface I { static void main(String[] a) {} }
}
class Other { public static void main(String[] a) {} }`;
  const found = findMains('shop/Main.java', src);
  assert.deepEqual(found.map((m) => m.className), ['shop.Main$Inner', 'shop.Main$P', 'shop.Main$E', 'shop.Main$I', 'shop.Other']);
  assert.equal(found[0].label, 'shop.Main.Inner');
  assert.equal(found[0].path, 'shop/Main.java');
});

test('arguments follow POSIX shell quoting', () => {
  assert.deepEqual(parseArgs(''), []);
  assert.deepEqual(parseArgs('  a  b '), ['a', 'b']);
  assert.deepEqual(parseArgs('"two words" café'), ['two words', 'café']);
  assert.deepEqual(parseArgs(String.raw`a\ b \"q\" \\ \d+`), ['a b', '"q"', '\\', 'd+'], 'outside quotes \\ escapes the next char');
  assert.deepEqual(parseArgs(String.raw`'\d+' 'a\b' 'say "hi"'`), ['\\d+', 'a\\b', 'say "hi"'], "'…' is literal");
  assert.deepEqual(parseArgs(String.raw`"\d" "\"" "\\" "\$" "a\b"`), ['\\d', '"', '\\', '$', 'a\\b'], 'bash rules inside "…"');
  assert.deepEqual(parseArgs(`a"b c"d '' ""`), ['ab cd', '', '']);
  assert.deepEqual(parseArgs(`'it'\\''s' x#y * ~`), ["it's", 'x#y', '*', '~'], "no glob or ~ expansion; # mid-word is text");
});

test('shell features Kopje lacks are rejected, not silently passed on', () => {
  for (const [line, re] of [
    ['a | b', /pipe/], ['a > out.txt', /redirection/], ['a < in', /redirection/], ['a; b', /several commands/],
    ['a &', /background/], ['$(ls)', /variable/], ['$HOME', /variable/], ['"$HOME"', /variable/], ['`ls`', /command substitution/],
    ['a #comment', /comment/], ['"open', /closing " missing/], ["'open", /closing ' missing/], ['end\\', /final/],
  ]) assert.throws(() => parseArgs(line), re, line);
  assert.deepEqual(parseArgs(`'a | b' \\> "x;y" '$HOME' \\$1`), ['a | b', '>', 'x;y', '$HOME', '$1'], 'quoted or escaped they are text');
  assert.throws(() => parseArgs('x'.repeat(1001)), /too long/);
});
