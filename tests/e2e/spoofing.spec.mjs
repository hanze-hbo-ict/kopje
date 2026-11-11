// PLAN.md §13 S9: student code can spoof its own status events, but nothing it sends can
// become markup or script in the IDE.
import { test, expect } from '@playwright/test';
import { useExampleProject } from '../fixtures/example-project.mjs';

const PAYLOAD = '<img src=x onerror="window.__pwned=1"><b>bold</b>';

async function setSource(page, text) {
  await page.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.press('Delete');
  await page.keyboard.insertText(text);
}

test('S9: spoofed diagnostics and HTML output render as plain text', async ({ page }) => {
  await useExampleProject(page);
  await page.goto('/');
  await expect(page.locator('#status')).toHaveAttribute('data-state', 'ready', { timeout: 120_000 });
  const json = JSON.stringify({ t: 'compiled', ok: false, ms: 0, diagnostics: [
    { file: PAYLOAD, line: 1, column: 1, severity: 'error', message: PAYLOAD },
    { file: 'example/Main.java', line: 1, column: 1, severity: 'error', message: PAYLOAD },
  ] }).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  await setSource(page, `package example;

import java.io.*;

public class Main {
    public static void main(String[] args) throws Exception {
        System.out.println("${PAYLOAD.replace(/"/g, '\\"')}");
        System.err.println("${PAYLOAD.replace(/"/g, '\\"')}");
        System.out.flush();
        try (FileOutputStream ctl = new FileOutputStream("/dev/jectl")) {
            ctl.write(("${json}" + "\\n").getBytes("UTF-8"));
        }
        Thread.sleep(200);
    }
}
`);
  await page.locator('#run').click();
  // The spoofed "compiled: failed" event ends the run like a real compile error would.
  await expect(page.locator('.diagnostics')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('#output')).toContainText(PAYLOAD);           // literal text
  await expect(page.locator('.diagnostics')).toContainText(PAYLOAD);
  expect(await page.locator('#output img, #output b, #notes img, #notes b, #error img').count()).toBe(0);
  expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
  // Clicking the spoofed diagnostic for an unknown file does nothing harmful.
  await page.locator('.diagnostics button').first().click();
  await expect(page.locator('#filename-text')).toHaveText('example/Main.java');
  // The IDE still works afterwards.
  await setSource(page, 'package example;\n\npublic class Main {\n    public static void main(String[] args) {\n        System.out.println("ok");\n    }\n}\n');
  await page.locator('#run').click();
  await expect(page.locator('#output')).toHaveText('ok\n', { timeout: 60_000 });
});
