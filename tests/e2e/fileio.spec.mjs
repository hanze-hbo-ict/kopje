// PLAN.md F1: java.io and java.nio.file on the runtime's ephemeral MEMFS.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const SOURCE = readFileSync(new URL('../fixtures/file-io/Main.java', import.meta.url), 'utf8');

test('file I/O: java.io and java.nio.file', async ({ page }) => {
  await page.goto('/slice.html');
  await page.waitForFunction(() => window.bootMs !== undefined, null, { timeout: 120_000 });
  const { result, stdout, stderr } = await page.evaluate((src) => new Promise((resolve) => {
    const out = [], err = [];
    window.engine.run({ 'Main.java': src }, 'Main', (e) => {
      if (e.kind === 'stdout') out.push(e.text);
      if (e.kind === 'stderr') err.push(e.text);
    }).then((r) => resolve({ result: r, stdout: out.join(''), stderr: err.join('') }));
  }), SOURCE);
  console.log(stdout);
  expect(result, stderr).toMatchObject({ status: 'exit', code: 0 });
  const lines = Object.fromEntries(stdout.trim().split('\n').map((l) => { const i = l.indexOf(': '); return [l.slice(0, i), l.slice(i + 2)]; }));
  const failures = Object.entries(lines).filter(([, v]) => v.startsWith('FAIL'));
  expect(failures, 'operations that failed').toEqual([]);
  // Spot-check semantics, not just "no exception".
  expect(lines['io.BufferedReader']).toBe('OK hello|café €|third');
  expect(lines['nio.readString']).toBe('OK één|twee|');
  expect(lines['nio.readAllLines']).toBe('OK [één, twee]');
  expect(lines['nio.createFile exists']).toBe('OK FileAlreadyExistsException');
  expect(lines['nio.notFound']).toBe('OK NoSuchFileException');
  expect(lines['nio.dirNotEmpty']).toBe('OK DirectoryNotEmptyException');
  expect(lines['nio.size']).toBe('OK 16');
  expect(lines['nio.delete']).toBe('OK false');
  expect(lines['nio.outsideRoot']).toBe('OK NoSuchFileException');
  expect(lines['nio.copy']).toBe('OK /tmp/nio/copy.txt');
  expect(lines['nio.listUnicode']).toBe('OK naïve-ü.txt,new.txt');
  expect(lines['nio.copyDirTree']).toBe('OK 4');
});
