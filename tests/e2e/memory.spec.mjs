// E6: memory per runtime (WASM heap) and for the whole browser (renderer RSS). Chromium only.
import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';

const PROGRAM = { 'Main.java': 'import java.util.*; public class Main { public static void main(String[] a) { List<String> l = new ArrayList<>(); for (int i = 0; i < 20000; i++) l.add("s" + i); System.out.println(l.size()); } }' };

/** Resident memory of Chromium renderer processes, MB. */
function rendererRssMb() {
  const ps = execFileSync('ps', ['-Ao', 'rss=,command='], { encoding: 'utf8' });
  return Math.round(ps.split('\n').filter((l) => /headless_shell|Chromium|chrome/i.test(l) && /--type=renderer/.test(l))
    .reduce((sum, l) => sum + Number(l.trim().split(/\s+/)[0] || 0), 0) / 1024);
}

/** WASM heap size of every runtime iframe on the page, MB. */
const heapsMb = (page) => page.evaluate(() => Promise.all([...document.querySelectorAll('iframe')].map((f) => new Promise((resolve) => {
  const on = (e) => { if (e.source === f.contentWindow && e.data?.event?.kind === 'stats') { removeEventListener('message', on); resolve(Math.round(e.data.event.heapBytes / 1e6)); } };
  addEventListener('message', on);
  f.contentWindow.postMessage({ type: 'stats' }, '*'); // the sandboxed frame's origin is opaque
  setTimeout(() => resolve(null), 2000);
}))));

test('memory: boot, run, spare', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'renderer RSS measurement is written for Chromium');
  const base = rendererRssMb();
  await page.goto('/slice.html');
  await page.waitForFunction(() => window.bootMs !== undefined, null, { timeout: 120_000 });
  const booted = { heaps: await heapsMb(page), rss: rendererRssMb() - base };
  const r = await page.evaluate((f) => window.engine.run(f, 'Main', () => {}), PROGRAM);
  expect(r).toMatchObject({ status: 'exit', code: 0 });
  await page.waitForTimeout(4000); // the next spare has booted
  const after = { heaps: await heapsMb(page), rss: rendererRssMb() - base };
  console.log(`memory: booted heap=${booted.heaps} MB rss=${booted.rss} MB | after run+spare heap=${after.heaps} MB rss=${after.rss} MB`);
});

test('memory: large allocation works, overflow is a normal OutOfMemoryError', async ({ page }) => {
  await page.goto('/slice.html');
  await page.waitForFunction(() => window.bootMs !== undefined, null, { timeout: 120_000 });
  const run = (src) => page.evaluate((src) => new Promise((resolve) => {
    const out = [], err = [];
    window.engine.run({ 'Main.java': src }, 'Main', (e) => { if (e.kind === 'stdout') out.push(e.text); if (e.kind === 'stderr') err.push(e.text); })
      .then((r) => resolve({ r, out: out.join(''), err: err.join('') }));
  }), src);
  const big = await run('public class Main { public static void main(String[] a) { int[] x = new int[10_000_000]; x[9_999_999] = 7; System.out.println("ok " + x[9_999_999]); } }');
  expect(big.r, big.err).toMatchObject({ status: 'exit', code: 0 });
  expect(big.out).toBe('ok 7\n');
  const oom = await run('import java.util.*; public class Main { public static void main(String[] a) { List<long[]> l = new ArrayList<>(); while (true) l.add(new long[1_000_000]); } }');
  expect(oom.r).toMatchObject({ status: 'exit', code: 1 });
  expect(oom.err).toContain('java.lang.OutOfMemoryError');
  const after = await run('public class Main { public static void main(String[] a) { System.out.println("still fine"); } }');
  expect(after.out).toBe('still fine\n');
});

test('E6: without a pre-booted spare, consecutive runs still work', async ({ page }) => {
  await page.goto('/slice.html?prewarm=0');
  await page.waitForFunction(() => window.bootMs !== undefined, null, { timeout: 120_000 });
  for (let i = 0; i < 3; i++) {
    const r = await page.evaluate((i) => new Promise((resolve) => {
      const out = [];
      window.engine.run({ 'Main.java': `public class Main { public static void main(String[] a) { System.out.println("run ${i}"); } }` }, 'Main',
        (e) => { if (e.kind === 'stdout') out.push(e.text); }).then((r) => resolve({ ...r, out: out.join('') }));
    }), i);
    expect(r).toMatchObject({ status: 'exit', code: 0, out: `run ${i}\n` });
    // No spare: no runtime iframe remains between runs.
    expect(await page.locator('iframe').count()).toBe(0);
  }
});
