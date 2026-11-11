// PLAN.md §14 E1 (export / copy for Ans), E2 (import), E4 (unload warning, Reset).
import { test, expect } from '@playwright/test';

const UNICODE_SRC = 'package example;\n\npublic class Calculator {\n\t// tab-indented, café €\n\tpublic int add(int a, int b) {\n\t\treturn a + b;\n\t}\n}\n';

async function ready(page) {
  await expect(page.locator('#status')).toHaveAttribute('data-state', 'ready', { timeout: 120_000 });
}
async function setSource(page, text) {
  await page.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.press('Delete');
  await page.keyboard.insertText(text);
}
/** The bundle the app should produce for the given files (sorted by path). */
const bundle = (files) => Object.keys(files).sort().map((p) => `// File: ${p}\n${files[p]}\n`).join('');

test('E1: Export copies an exact bundle, or one file as is', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'clipboard permissions are scriptable in Chromium only');
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/');
  await ready(page);
  await page.locator('#file-list button[data-path="example/Calculator.java"]').click();
  await setSource(page, UNICODE_SRC);
  await page.waitForTimeout(500); // debounced save
  const files = (await page.evaluate(() => JSON.parse(sessionStorage.getItem('kopje:session:v1')))).project.files;
  expect(files['example/Calculator.java']).toBe(UNICODE_SRC);

  await page.locator('#project-export').click();
  const dialog = page.locator('#export');
  await expect(dialog).toBeVisible();
  await expect(page.locator('#export-all')).toBeChecked();
  await expect(page.locator('#export-preview')).toHaveValue(bundle(files));
  await page.locator('#export-copy').click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('#file-message')).toHaveText('Copied 2 files.');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(bundle(files));

  // A single file is exported without a header.
  await page.locator('#project-export').click();
  await page.locator('#export-list input[value="example/Main.java"]').uncheck();
  await expect(page.locator('#export-all')).not.toBeChecked();
  await expect(page.locator('#export-preview')).toHaveValue(UNICODE_SRC);
  await page.locator('#export-copy').click();
  await expect(page.locator('#file-message')).toHaveText('Copied example/Calculator.java.');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(UNICODE_SRC);

  // Nothing selected: nothing to copy.
  await page.locator('#project-export').click();
  await page.locator('#export-all').uncheck();
  await expect(page.locator('#export-preview')).toHaveValue('');
  await expect(page.locator('#export-copy')).toBeDisabled();
  await page.locator('#export-close').click();
});

test('E1: if the clipboard is refused, the preview is selected for manual copying', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: () => Promise.reject(new DOMException('denied', 'NotAllowedError')) } });
  });
  await page.goto('/');
  await ready(page);
  await page.locator('#project-export').click();
  await page.locator('#export-copy').click();
  const dialog = page.locator('#export');
  await expect(dialog).toBeVisible();
  await expect(page.locator('#export-message')).toContainText('Ctrl+C');
  const state = await page.evaluate(() => {
    const t = document.getElementById('export-preview');
    return { value: t.value, start: t.selectionStart, end: t.selectionEnd, readOnly: t.readOnly, focused: document.activeElement === t };
  });
  expect(state.value.startsWith('// File: example/Calculator.java\n')).toBe(true);
  expect(state.value).toContain('// File: example/Main.java\n');
  expect(state).toMatchObject({ start: 0, end: state.value.length, readOnly: true, focused: true });
  await page.locator('#export-close').click();
  await expect(dialog).toBeHidden();
});

test('E2: import a three-file project, run it; add with overwrite; invalid input', async ({ page }) => {
  page.on('dialog', (d) => d.accept());
  await page.goto('/');
  await ready(page);
  const files = {
    'shop/Main.java': 'package shop;\n\npublic class Main {\n    public static void main(String[] args) {\n        Cart c = new Cart();\n        c.add(new Item("pen", 150));\n        c.add(new Item("café", 250));\n        System.out.println(c.total() + " " + c.names());\n    }\n}\n',
    'shop/Cart.java': 'package shop;\n\nimport java.util.*;\n\nclass Cart {\n    private final List<Item> items = new ArrayList<>();\n    void add(Item i) { items.add(i); }\n    int total() { return items.stream().mapToInt(Item::cents).sum(); }\n    String names() { return items.stream().map(Item::name).toList().toString(); }\n}\n',
    'shop/Item.java': 'package shop;\n\nrecord Item(String name, int cents) {}',
  };
  await page.locator('#project-import').click();
  await page.locator('#transfer-text').fill(bundle(files));
  await page.locator('#transfer-replace').click();
  await expect(page.locator('#transfer')).toBeHidden();
  await expect(page.locator('#file-list button[data-path]')).toHaveCount(3);
  await expect(page.locator('#main-class')).toHaveValue('shop.Main');
  await expect(page.locator('#filename-text')).toHaveText('shop/Main.java');
  await page.locator('#run').click();
  await expect(page.locator('#output')).toHaveText('400 [pen, café]\n', { timeout: 60_000 });

  // Add: one new file and one overwrite.
  await page.locator('#project-import').click();
  await page.locator('#transfer-text').fill('// File: shop/Item.java\npackage shop;\n\nrecord Item(String name, int cents) { Item { if (cents < 0) throw new IllegalArgumentException(); } }\n// File: shop/Extra.java\npackage shop;\nclass Extra {}\n');
  await page.locator('#transfer-add').click();
  await expect(page.locator('#file-list button[data-path]')).toHaveCount(4);
  await page.locator('#file-list button[data-path="shop/Item.java"]').click();
  await expect(page.locator('.cm-content')).toContainText('IllegalArgumentException');

  // Invalid input keeps the dialog open with a message.
  await page.locator('#project-import').click();
  await page.locator('#transfer-text').fill('// File: ../evil.java\nx\n');
  await page.locator('#transfer-replace').click();
  await expect(page.locator('#transfer-message')).toContainText('may not contain');
  await expect(page.locator('#transfer')).toBeVisible();
  await page.locator('#transfer-close').click();

  // Single class without headers is added under its package path.
  await page.locator('#project-import').click();
  await page.locator('#transfer-text').fill('package util;\n\npublic class Strings { }\n');
  await page.locator('#transfer-add').click();
  await expect(page.locator('#file-list button[data-path="util/Strings.java"]')).toHaveCount(1);
});

test('E4: Reset returns to the last full import (plus added files); unload warning once modified', async ({ page }) => {
  await page.goto('/');
  await ready(page);
  const unloadWarns = () => page.evaluate(() => {
    const ev = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(ev);
    return ev.defaultPrevented;
  });
  expect(await unloadWarns(), 'no warning for the untouched template').toBe(false);

  // Without an import, Reset goes back to the example project.
  await page.locator('#file-new').click();
  await page.locator('.file-name-input').fill('extra/Note.java');
  await page.locator('.file-name-input').press('Enter');
  await expect(page.locator('#file-list button[data-path]')).toHaveCount(3);
  expect(await unloadWarns()).toBe(true);
  page.once('dialog', (d) => d.accept());
  await page.locator('#project-reset').click();
  await expect(page.locator('#file-list button[data-path]')).toHaveCount(2);
  await expect(page.locator('#filename-text')).toHaveText('example/Main.java');
  expect(await unloadWarns()).toBe(false);

  // After an import (replace + add), Reset goes back to those files, also after a reload.
  await page.locator('#project-import').click();
  await page.locator('#transfer-text').fill('// File: A.java\npublic class A { public static void main(String[] a) {} }\n');
  await page.locator('#transfer-replace').click();
  await page.locator('#project-import').click();
  await page.locator('#transfer-text').fill('// File: B.java\nclass B {}\n');
  await page.locator('#transfer-add').click();
  await page.locator('#file-list button[data-path="A.java"]').click();
  await setSource(page, 'class A { int changed; }\n');
  await page.reload();
  await ready(page);
  page.once('dialog', (d) => d.accept());
  await page.locator('#project-reset').click();
  await expect(page.locator('#file-message')).toHaveText('Reset to the last imported project.');
  await expect(page.locator('#file-list button[data-path]')).toHaveCount(2);
  await expect(page.locator('#filename-text')).toHaveText('A.java');
  await expect(page.locator('.cm-content')).toContainText('public static void main');
});
