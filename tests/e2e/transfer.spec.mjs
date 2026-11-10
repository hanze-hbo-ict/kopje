// PLAN.md §14 E1 (copy for Ans), E2 (paste project), E4 (unload warning, New project).
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

test('E1: Copy all puts an exact bundle on the clipboard', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'clipboard permissions are scriptable in Chromium only');
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/');
  await ready(page);
  await page.locator('#file-list button[data-path="example/Calculator.java"]').click();
  await setSource(page, UNICODE_SRC);
  await page.locator('#copy-all').click();
  await expect(page.locator('#file-message')).toHaveText('Copied 2 files.');
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  await page.waitForTimeout(500); // debounced save
  const files = (await page.evaluate(() => JSON.parse(sessionStorage.getItem('javaedit:session:v1')))).project.files;
  expect(files['example/Calculator.java']).toBe(UNICODE_SRC);
  expect(clip).toBe(bundle(files));
  await page.locator('#copy-file').click();
  await expect(page.locator('#file-message')).toHaveText('Copied example/Calculator.java.');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(UNICODE_SRC);
});

test('E1: if the clipboard is refused, the text is shown selected for manual copying', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: () => Promise.reject(new DOMException('denied', 'NotAllowedError')) } });
  });
  await page.goto('/');
  await ready(page);
  await page.locator('#copy-all').click();
  const dialog = page.locator('#transfer');
  await expect(dialog).toBeVisible();
  await expect(page.locator('#transfer-title')).toHaveText('Copy 2 files');
  const state = await page.evaluate(() => {
    const t = document.getElementById('transfer-text');
    return { value: t.value, start: t.selectionStart, end: t.selectionEnd, readOnly: t.readOnly, focused: document.activeElement === t };
  });
  expect(state.value.startsWith('// File: example/Calculator.java\n')).toBe(true);
  expect(state.value).toContain('// File: example/Main.java\n');
  expect(state).toMatchObject({ start: 0, end: state.value.length, readOnly: true, focused: true });
  await expect(page.locator('#transfer-replace')).toBeHidden();
  await page.locator('#transfer-close').click();
  await expect(dialog).toBeHidden();
});

test('E2: paste a three-file project, run it; add with overwrite; invalid input', async ({ page }) => {
  page.on('dialog', (d) => d.accept());
  await page.goto('/');
  await ready(page);
  const files = {
    'shop/Main.java': 'package shop;\n\npublic class Main {\n    public static void main(String[] args) {\n        Cart c = new Cart();\n        c.add(new Item("pen", 150));\n        c.add(new Item("café", 250));\n        System.out.println(c.total() + " " + c.names());\n    }\n}\n',
    'shop/Cart.java': 'package shop;\n\nimport java.util.*;\n\nclass Cart {\n    private final List<Item> items = new ArrayList<>();\n    void add(Item i) { items.add(i); }\n    int total() { return items.stream().mapToInt(Item::cents).sum(); }\n    String names() { return items.stream().map(Item::name).toList().toString(); }\n}\n',
    'shop/Item.java': 'package shop;\n\nrecord Item(String name, int cents) {}',
  };
  await page.locator('#paste-project').click();
  await page.locator('#transfer-text').fill(bundle(files));
  await page.locator('#transfer-replace').click();
  await expect(page.locator('#transfer')).toBeHidden();
  await expect(page.locator('#file-list button[data-path]')).toHaveCount(3);
  await expect(page.locator('#main-class')).toHaveValue('shop.Main');
  await expect(page.locator('#filename-text')).toHaveText('shop/Main.java');
  await page.locator('#run').click();
  await expect(page.locator('#output')).toHaveText('400 [pen, café]\n', { timeout: 60_000 });

  // Add: one new file and one overwrite.
  await page.locator('#paste-project').click();
  await page.locator('#transfer-text').fill('// File: shop/Item.java\npackage shop;\n\nrecord Item(String name, int cents) { Item { if (cents < 0) throw new IllegalArgumentException(); } }\n// File: shop/Extra.java\npackage shop;\nclass Extra {}\n');
  await page.locator('#transfer-add').click();
  await expect(page.locator('#file-list button[data-path]')).toHaveCount(4);
  await page.locator('#file-list button[data-path="shop/Item.java"]').click();
  await expect(page.locator('.cm-content')).toContainText('IllegalArgumentException');

  // Invalid input keeps the dialog open with a message.
  await page.locator('#paste-project').click();
  await page.locator('#transfer-text').fill('// File: ../evil.java\nx\n');
  await page.locator('#transfer-replace').click();
  await expect(page.locator('#transfer-message')).toContainText('may not contain');
  await expect(page.locator('#transfer')).toBeVisible();
  await page.locator('#transfer-close').click();

  // Single class without headers is added under its package path.
  await page.locator('#paste-project').click();
  await page.locator('#transfer-text').fill('package util;\n\npublic class Strings { }\n');
  await page.locator('#transfer-add').click();
  await expect(page.locator('#file-list button[data-path="util/Strings.java"]')).toHaveCount(1);
});

test('E4: New project resets and clears storage; unload warning once modified', async ({ page }) => {
  await page.goto('/');
  await ready(page);
  await page.locator('#file-new').click();
  await page.locator('.file-name-input').fill('extra/Note.java');
  await page.locator('.file-name-input').press('Enter');
  await expect(page.locator('#file-list button[data-path]')).toHaveCount(3);

  // Unload warning while modified.
  const fired = await page.evaluate(() => {
    const ev = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(ev);
    return ev.defaultPrevented;
  });
  expect(fired).toBe(true);

  page.once('dialog', (d) => d.accept());
  await page.locator('#new-project').click();
  await expect(page.locator('#file-list button[data-path]')).toHaveCount(2);
  await expect(page.locator('#filename-text')).toHaveText('example/Main.java');
  expect(await page.evaluate(() => sessionStorage.getItem('javaedit:session:v1'))).toBeNull();
  const firedAfter = await page.evaluate(() => {
    const ev = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(ev);
    return ev.defaultPrevented;
  });
  expect(firedAfter, 'no warning for the untouched template').toBe(false);
});
