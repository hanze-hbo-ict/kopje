import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serializeProject, parseBundle, derivePath } from '../../src/project/bundle.ts';

const plain = (o) => ({ ...o });

test('round trip is lossless, including files without trailing newline, tabs, CRLF-free Unicode', () => {
  const files = {
    'example/Main.java': 'package example;\n\nclass Main {\n\tString s = "café €";\n}\n',
    'example/NoNewline.java': 'class NoNewline {}',
    'Two.java': 'class Two {}\n\n\n',
    'Empty.java': '',
  };
  const text = serializeProject(files);
  assert.match(text, /^\/\/ File: Empty\.java\n/);
  assert.deepEqual(plain(parseBundle(text)), files);
});

test('CRLF pasted text is normalised', () => {
  const r = parseBundle('// File: A.java\r\nclass A {}\r\n');
  assert.deepEqual(plain(r), { 'A.java': 'class A {}' });
});

test('single class without headers derives its path', () => {
  assert.equal(derivePath('package a.b;\n\npublic class Foo { }'), 'a/b/Foo.java');
  assert.equal(derivePath('/* package x; */ // class Nope\nrecord Point(int x, int y) {}'), 'Point.java');
  assert.equal(derivePath('public final class Z {}'), 'Z.java');
  assert.deepEqual(Object.keys(parseBundle('package p;\nclass Q {}\n')), ['p/Q.java']);
  assert.throws(() => derivePath('int x = 1;'), /Could not find/);
});

test('rejects unsafe or ambiguous bundles', () => {
  assert.throws(() => parseBundle(''), /empty/);
  assert.throws(() => parseBundle('// File: ../evil.java\nx\n'), /Line 1/);
  assert.throws(() => parseBundle('// File: A.java\na\n// File: A.java\nb\n'), /twice/);
  assert.throws(() => parseBundle('stray\n// File: A.java\na\n'), /before the first/);
  assert.throws(() => parseBundle('// File: A.java\na\n// File: a.java\nb\n'), /Duplicate/);
});

test('data files round trip through the bundle format', () => {
  const files = { 'data/scores.csv': 'name,score\nAna,8\nBo,6\n', 'input': 'no trailing newline', 'Main.java': 'public class Main {}\n' };
  const paths = Object.keys(files).sort();
  assert.deepEqual(plain(parseBundle(serializeProject(files, paths))), files);
  assert.throws(() => parseBundle('// File: data/my scores.csv\nx\n'), /letters, digits/);
});
