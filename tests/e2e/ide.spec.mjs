// Gate 4: the IDE (index.html) end to end, through the UI only.
import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const SHOTS = 'test-results/screenshots';
mkdirSync(SHOTS, { recursive: true });

const status = (page) => page.locator('#status');
const output = (page) => page.locator('#output');
const fileButton = (page, path) => page.locator(`#file-list button[data-path="${path}"]`);

async function ready(page) {
  await expect(status(page)).toHaveAttribute('data-state', 'ready', { timeout: 120_000 });
}

/** Replace the active file's text (insertText avoids auto-closed brackets). */
async function setSource(page, text) {
  await page.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.press('Delete');
  await page.keyboard.insertText(text);
}

async function answer(page, text) {
  const input = page.locator('#answer');
  await expect(input).toBeVisible({ timeout: 60_000 });
  await expect(input).toBeFocused();
  await input.fill(text);
  await input.press('Enter');
}

test('Gate 4: two-file project, stdin, stop, diagnostics, files, reload, fresh session', async ({ page, browser, browserName }) => {
  page.on('dialog', (d) => d.accept());
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await ready(page);

  // Template: two files in package example, main class example.Main.
  await expect(page.locator('#file-list button[data-path]')).toHaveCount(2);
  await expect(page.locator('#main-class')).toHaveValue('example.Main');
  await expect(page.locator('#filename-text')).toHaveText('example/Main.java');
  await page.screenshot({ path: `${SHOTS}/${browserName}-desktop-ready.png` });

  // Run: interactive prompts without newline, two sequential inputs.
  await page.locator('#run').click();
  await expect(output(page)).toHaveText('First number: ', { timeout: 60_000 });
  await expect(status(page)).toHaveText('Waiting for input');
  await answer(page, '2');
  await expect(output(page)).toHaveText('First number: 2\nSecond number: ');
  await page.screenshot({ path: `${SHOTS}/${browserName}-desktop-waiting.png` });
  await answer(page, '3');
  await expect(output(page)).toHaveText('First number: 2\nSecond number: 3\n2 + 3 = 5\n');
  await expect(status(page)).toHaveText('Ready');
  await expect(page.locator('#run')).toHaveAttribute('data-action', 'run');

  // Edit the second file; the change is used by the next run (no stale classes).
  await fileButton(page, 'example/Calculator.java').click();
  await expect(page.locator('#filename-text')).toHaveText('example/Calculator.java');
  await setSource(page, 'package example;\n\npublic class Calculator {\n    public int add(int a, int b) {\n        return a * b + 1;\n    }\n}\n');
  await page.locator('#run').click();
  await answer(page, '4');
  await answer(page, '5');
  await expect(output(page)).toContainText('4 + 5 = 21');

  // Stop while blocked in Scanner.nextLine; the next run works.
  await page.locator('#run').click();
  await expect(page.locator('#answer')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('#run')).toHaveAttribute('data-action', 'stop');
  await page.locator('#run').click();
  await expect(page.locator('#notes')).toHaveText('Stopped.');
  await expect(status(page)).toHaveText('Ready');
  await expect(page.locator('#answer')).toBeHidden();

  // Syntax error in the second file -> clickable, file-specific diagnostic.
  await setSource(page, 'package example;\n\npublic class Calculator {\n    public int add(int a, int b) {\n        return a + b\n    }\n}\n');
  await fileButton(page, 'example/Main.java').click();
  await page.locator('#run').click();
  const diag = page.locator('.diagnostics button').first();
  await expect(diag).toContainText('example/Calculator.java:5', { timeout: 60_000 });
  await expect(diag).toContainText("';' expected");
  await expect(page.locator('#filename-text')).toHaveText('example/Calculator.java'); // auto-opened
  await page.screenshot({ path: `${SHOTS}/${browserName}-desktop-diagnostic.png` });
  await fileButton(page, 'example/Main.java').click();
  await diag.click();
  await expect(page.locator('#filename-text')).toHaveText('example/Calculator.java');
  await expect(page.locator('.cm-diagnosticLine')).toContainText('return a + b');
  await setSource(page, 'package example;\n\npublic class Calculator {\n    public int add(int a, int b) {\n        return a + b;\n    }\n}\n');

  // New file in a new package, select it as main class, run it.
  await page.locator('#file-new').click();
  const field = page.locator('.file-name-input');
  await expect(field).toBeFocused();
  await field.fill('tools/Hello.java');
  await field.press('Enter');
  await expect(fileButton(page, 'tools/Hello.java')).toHaveAttribute('aria-current', 'true');
  await expect(page.locator('.cm-content')).toContainText('package tools;');
  await setSource(page, 'package tools;\n\npublic class Hello {\n    public static void main(String[] args) {\n        System.out.println("Hello from " + new example.Calculator().add(40, 2));\n    }\n}\n');
  await expect(page.locator('#main-class option')).toHaveText(['example.Main', 'tools.Hello']); // only classes with main()
  await page.locator('#main-class').selectOption('tools.Hello');
  await page.locator('#run').click();
  await expect(output(page)).toHaveText('Hello from 42\n', { timeout: 60_000 });

  // Invalid names are rejected with a message.
  await page.locator('#file-new').click();
  await field.fill('../evil.java');
  await field.press('Enter');
  await expect(page.locator('#file-message')).toContainText('may not contain');
  await field.press('Escape');

  // Rename changes the file only; the main class keeps the name declared in the source.
  await fileButton(page, 'tools/Hello.java').click();
  await page.locator('#file-rename').click();
  await field.fill('tools/Greeter.java');
  await field.press('Enter');
  await expect(fileButton(page, 'tools/Greeter.java')).toBeVisible();
  await expect(page.locator('#main-class')).toHaveValue('tools.Hello');
  // Renaming the class in the source moves the selection with it.
  await setSource(page, 'package tools;\n\npublic class Greeter {\n    public static void main(String[] args) {\n        System.out.println("Hello from " + new example.Calculator().add(40, 2));\n    }\n}\n');
  await expect(page.locator('#main-class')).toHaveValue('tools.Greeter');

  // Reload the tab: files, active file and main class are restored.
  await page.reload();
  await ready(page);
  await expect(page.locator('#file-list button[data-path]')).toHaveCount(3);
  await expect(page.locator('#filename-text')).toHaveText('tools/Greeter.java');
  await expect(page.locator('#main-class')).toHaveValue('tools.Greeter');
  await expect(page.locator('.cm-content')).toContainText('Hello from');
  await expect(output(page)).toBeEmpty(); // console contents are not persisted

  await fileButton(page, 'tools/Greeter.java').click();
  await page.locator('#file-delete').click();
  await expect(fileButton(page, 'tools/Greeter.java')).toHaveCount(0);
  await expect(page.locator('#main-class')).toHaveValue('example.Main');

  // A fresh, independent browser session starts from the template.
  const fresh = await browser.newContext();
  const p2 = await fresh.newPage();
  await p2.goto('/');
  await expect(p2.locator('#file-list button[data-path]')).toHaveCount(2);
  await expect(p2.locator('#filename-text')).toHaveText('example/Main.java');
  await fresh.close();
});

test('mobile layout and dark theme', async ({ page, browserName }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await ready(page);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  expect(overflow, 'no horizontal page scroll').toBeLessThanOrEqual(0);
  await page.locator('#theme').click(); // system -> light
  await page.locator('#theme').click(); // light -> dark
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.locator('#run').click();
  await expect(page.locator('#answer')).toBeVisible({ timeout: 60_000 });
  await page.screenshot({ path: `${SHOTS}/${browserName}-mobile-dark-waiting.png` });
  await page.locator('#answer').fill('7');
  await page.locator('#answer').press('Enter');
  await page.locator('#answer').fill('8');
  await page.locator('#answer').press('Enter');
  await expect(output(page)).toContainText('7 + 8 = 15');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark'); // UI state restored
});

test('command line: arguments reach String[] args, Enter runs, echo shows the command', async ({ page }) => {
  page.on('dialog', (d) => d.accept());
  await page.goto('/');
  await ready(page);
  await setSource(page, 'package example;\n\npublic class Main {\n    public static void main(String[] args) {\n        System.out.println(args.length + " " + String.join("|", args));\n    }\n}\n');
  const args = page.locator('#args');
  await args.fill('3 "two words" café');
  await args.press('Enter');
  await expect(output(page)).toHaveText('3 3|two words|café\n', { timeout: 60_000 });
  await expect(page.locator('#command-echo')).toHaveText('$ java example.Main 3 "two words" café');

  // An unclosed quote is reported instead of running.
  await args.fill('"oops');
  await expect(args).toHaveAttribute('aria-invalid', 'true');
  await page.locator('#run').click();
  await expect(page.locator('#error')).toContainText('closing " missing');

  // Arguments survive a reload of the tab.
  await args.fill('1 2');
  await page.reload();
  await ready(page);
  await expect(page.locator('#args')).toHaveValue('1 2');
  await page.locator('#run').click();
  await expect(output(page)).toHaveText('2 1|2\n', { timeout: 60_000 });
});
