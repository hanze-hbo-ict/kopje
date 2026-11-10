import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePath, validateFiles, isValidMainClass, pathToClassName, sanitizeInput } from '../../src/project/paths.ts';

test('accepts package-relative paths', () => {
  assert.equal(normalizePath('Main.java'), 'Main.java');
  assert.equal(normalizePath(' example/Main.java '), 'example/Main.java');
  assert.equal(normalizePath('a//b/C.java'), 'a/b/C.java');
});

test('rejects traversal, absolute, odd names', () => {
  for (const bad of ['../Main.java', 'a/../Main.java', './Main.java', '/abs/Main.java', 'a\\Main.java',
                     'Main.txt', 'Main', '1bad/Main.java', 'my pkg/Main.java', 'a/.java', '', 'a/b/']) {
    assert.throws(() => normalizePath(bad), undefined, bad);
  }
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
