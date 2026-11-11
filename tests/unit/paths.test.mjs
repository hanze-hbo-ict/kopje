import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePath, validateFiles, isValidMainClass, pathToClassName, sanitizeInput, isJavaPath } from '../../src/project/paths.ts';

test('accepts package-relative paths', () => {
  assert.equal(normalizePath('Main.java'), 'Main.java');
  assert.equal(normalizePath(' example/Main.java '), 'example/Main.java');
  assert.equal(normalizePath('a//b/C.java'), 'a/b/C.java');
});

test('rejects traversal, absolute, odd names', () => {
  for (const bad of ['../Main.java', 'a/../Main.java', './Main.java', '/abs/Main.java', 'a\\Main.java',
                     '1bad/Main.java', 'my pkg/Main.java', 'a/.java', '', 'a/b/']) {
    assert.throws(() => normalizePath(bad), undefined, bad);
  }
});

test('data files: any name except .java/.class, a restricted character set', () => {
  for (const ok of ['scores.csv', 'data/scores.csv', 'input', 'README', 'data-2024/a_b.c.txt', '2024/x.json', 'notes.JSON']) {
    assert.equal(normalizePath(ok), ok, ok);
    assert.equal(isJavaPath(ok), false, ok);
  }
  for (const bad of ['.hidden', 'data/.env', '-rf', 'my data.txt', 'data/../x.txt', 'café.txt', 'a/b c/x', 'Main.class', 'Main.JAVA', 'Main.Java']) {
    assert.throws(() => normalizePath(bad), undefined, bad);
  }
  assert.throws(() => normalizePath('x/Main.class'), /class files/);
  assert.throws(() => normalizePath('Main.JAVA'), /lower case/);
  assert.ok(isJavaPath('a/Main.java'));
});

test('a file may not share its name with a folder', () => {
  assert.throws(() => validateFiles({ 'data': '', 'data/x.txt': '' }), /both a file and a folder/);
  assert.throws(() => validateFiles({ 'Data': '', 'data/x.txt': '' }), /both a file and a folder/);
  assert.deepEqual(Object.keys(validateFiles({ 'data/x.txt': '', 'data/y.txt': '', 'example/Main.java': '' })).sort(), ['data/x.txt', 'data/y.txt', 'example/Main.java']);
});

test('rejects duplicates after normalisation (incl. case-folded)', () => {
  assert.throws(() => validateFiles({ 'a/Main.java': '', 'a//Main.java': '' }), /Duplicate/);
  assert.throws(() => validateFiles({ 'Main.java': '', 'main.java': '' }), /Duplicate/);
});

test('rejects oversized projects', () => {
  const files = {};
  for (let i = 0; i < 201; i++) files[`F${i}.java`] = '';
  assert.throws(() => validateFiles(files), /Too many/);
  assert.throws(() => validateFiles({ 'Big.java': 'x'.repeat(200_001) }), /too large/);
});

test('main class names', () => {
  assert.ok(isValidMainClass('example.Main'));
  assert.ok(isValidMainClass('Main'));
  for (const bad of ['', 'a..b', '.Main', 'Main.', 'a b', 'Main\nJBOX', '1x']) assert.ok(!isValidMainClass(bad), bad);
  assert.equal(pathToClassName('example/util/Calc.java'), 'example.util.Calc');
});

test('sanitizeInput removes the reserved EOF byte and other control chars', () => {
  assert.equal(sanitizeInput('a\x04b\r\nc\td\x1b[0m'), 'ab\nc\td[0m');
});
