// PLAN.md §16 F2: data files in the project, copied into the program's working directory.
import { test, expect } from '@playwright/test';

async function ready(page) {
  await expect(page.locator('#status')).toHaveAttribute('data-state', 'ready', { timeout: 120_000 });
}
const bundle = (files) => Object.keys(files).sort().map((p) => `// File: ${p}\n${files[p]}\n`).join('');

test('F2: an imported data file is readable from the working directory; sources and data stay apart', async ({ page }) => {
  page.on('dialog', (d) => d.accept());
  await page.goto('/');
  await ready(page);
  const files = {
    'app/Main.java': `package app;

import java.io.*;
import java.nio.file.*;
import java.util.*;

public class Main {
    public static void main(String[] args) throws IOException {
        int sum = 0;
        try (Scanner in = new Scanner(new File("data/scores.csv"))) {
            in.nextLine();
            while (in.hasNextLine()) sum += Integer.parseInt(in.nextLine().split(",")[1]);
        }
        System.out.println("sum " + sum);
        System.out.println("nio " + Files.readAllLines(Path.of("data", "scores.csv")).size());
        System.out.println("readme " + Files.readString(Path.of("README")).strip());
        System.out.println("cwd " + System.getProperty("user.dir"));
        System.out.println("sources visible " + Files.exists(Path.of("app/Main.java")));
    }
}`,
    'data/scores.csv': 'name,score\nAna,8\nBo,6\nCé,7\n',
    'README': 'café € data',
    // Not Java: if it reached javac, the run would fail with a compile error.
    'notes.txt': 'this is { not java',
  };
  await page.locator('#project-import').click();
  await page.locator('#transfer-text').fill(bundle(files));
  await page.locator('#transfer-replace').click();
  await expect(page.locator('#file-list button[data-path]')).toHaveCount(4);
  await expect(page.locator('#main-class')).toHaveValue('app.Main');
  await expect(page.locator('#file-list button[data-path="data/scores.csv"]')).toHaveClass(/file-data/);
  await expect(page.locator('#file-list button[data-path="app/Main.java"]')).not.toHaveClass(/file-data/);

  await page.locator('#run').click();
  await expect(page.locator('#output')).toHaveText('sum 21\nnio 4\nreadme café € data\ncwd /root\nsources visible false\n', { timeout: 60_000 });

  // A data file opens as plain text: marked in the header, no Java highlighting.
  await page.locator('#file-list button[data-path="notes.txt"]').click();
  await expect(page.locator('#filename')).toHaveAttribute('data-kind', 'data');
  await expect(page.locator('.cm-content')).toHaveAttribute('aria-label', 'notes.txt text');
});

test('F2: new files start empty, for sources and data files alike', async ({ page }) => {
  await page.goto('/');
  await ready(page);
  for (const name of ['example/Helper.java', 'data/input.txt']) {
    await page.locator('#file-new').click();
    await page.locator('.file-name-input').fill(name);
    await page.locator('.file-name-input').press('Enter');
    await expect(page.locator('#filename-text')).toHaveText(name);
    await expect(page.locator('.cm-content')).toHaveText('');
  }
  // Names a data file can't have are refused with a message.
  await page.locator('#file-new').click();
  await page.locator('.file-name-input').fill('data/my scores.csv');
  await page.locator('.file-name-input').press('Enter');
  await expect(page.locator('.file-name-input')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('#file-message')).toContainText('letters, digits');
});
