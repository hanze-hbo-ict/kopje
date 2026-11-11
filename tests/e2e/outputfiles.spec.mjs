// PLAN.md §16 F3: files written by the program, listed under the console with facts only.
import { test, expect } from '@playwright/test';

async function ready(page) {
  await expect(page.locator('#status')).toHaveAttribute('data-state', 'ready', { timeout: 120_000 });
}
const bundle = (files) => Object.keys(files).sort().map((p) => `// File: ${p}\n${files[p]}\n`).join('');
async function importProject(page, files) {
  page.on('dialog', (d) => d.accept());
  await page.locator('#project-import').click();
  await page.locator('#transfer-text').fill(bundle(files));
  await page.locator('#transfer-replace').click();
  await expect(page.locator('#transfer')).toBeHidden();
}
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

test('F3: written files are listed with facts and can be viewed, copied and kept', async ({ page }) => {
  const violations = [];
  // Firefox notes that frame-ancestors takes precedence over X-Frame-Options: expected, not a violation.
  page.on('console', (m) => { if (/Content.Security.Policy/i.test(m.text()) && !/Ignoring ‘x-frame-options’/.test(m.text())) violations.push(m.text()); });
  await page.goto('/');
  await ready(page);
  await importProject(page, {
    'Main.java': `import java.io.*;
import java.nio.file.*;
import java.util.Base64;

public class Main {
    public static void main(String[] args) throws Exception {
        try (PrintWriter w = new PrintWriter("results.txt")) {
            w.println("Ana 8"); w.println("Bo 6"); w.println("Cé 7");
        }
        PrintWriter forgotten = new PrintWriter("empty.txt");
        forgotten.println("never flushed");
        try (DataOutputStream d = new DataOutputStream(new FileOutputStream("/tmp/data.bin"))) { d.writeInt(42); }
        Files.write(Path.of("pic.png"), Base64.getDecoder().decode("${PNG}"));
        Files.writeString(Path.of("drawing.svg"), "<svg xmlns=\\"http://www.w3.org/2000/svg\\" width=\\"20\\" height=\\"20\\"><circle cx=\\"10\\" cy=\\"10\\" r=\\"8\\"/></svg>");
        Files.writeString(Path.of("data/scores.csv"), "name,score\\nAna,9\\n");
        Files.writeString(Path.of("data/same.csv"), Files.readString(Path.of("data/same.csv")));
        System.out.println("done");
    }
}`,
    'data/scores.csv': 'name,score\nAna,8\n',
    'data/same.csv': 'unchanged\n',
  });
  await expect(page.locator('#output-files')).toBeHidden();
  await page.locator('#run').click();
  await expect(page.locator('#output')).toHaveText('done\n', { timeout: 60_000 });

  const bar = page.locator('#output-files');
  await expect(bar).toBeVisible();
  await expect(page.locator('#output-files-title')).toHaveText('Files written · 6');
  await expect(page.locator('.output-file-name')).toHaveText(['data/scores.csv', 'drawing.svg', 'empty.txt', 'pic.png', 'results.txt', '/tmp/data.bin']);
  await expect(page.locator('.output-file-facts')).toHaveText([
    'changed · text · 2 lines · 17 B', /^SVG image · \d+ B$/, 'empty', /^PNG image · \d+ B$/, 'text · 3 lines · 17 B', 'binary · 4 B',
  ]);

  // Text: shown read-only, can be added to the project.
  const viewer = page.locator('#file-viewer');
  await page.locator('.output-file', { hasText: 'results.txt' }).click();
  await expect(viewer).toBeVisible();
  await expect(page.locator('#viewer-title')).toHaveText('results.txt');
  await expect(page.locator('.viewer-text')).toHaveValue('Ana 8\nBo 6\nCé 7\n');
  await expect(page.locator('#viewer-copy')).toBeVisible();
  await page.locator('#viewer-add').click();
  await expect(viewer).toBeHidden();
  await expect(page.locator('#file-list button[data-path="results.txt"]')).toHaveCount(1);
  await expect(page.locator('#filename-text')).toHaveText('results.txt');
  await expect(page.locator('.cm-content')).toContainText('Bo 6');

  // A changed data file replaces the project copy after confirmation.
  await page.locator('.output-file', { hasText: 'data/scores.csv' }).click();
  await page.locator('#viewer-add').click();
  await page.locator('#file-list button[data-path="data/scores.csv"]').click();
  await expect(page.locator('.cm-content')).toContainText('Ana,9');

  // Image and SVG render (CSP allows blob: images); SVG source can be shown.
  await page.locator('.output-file', { hasText: 'pic.png' }).click();
  await expect(page.locator('.viewer-image')).toBeVisible();
  expect(await page.locator('.viewer-image').evaluate((img) => img.complete && img.naturalWidth)).toBe(1);
  await expect(page.locator('#viewer-add')).toBeHidden();
  await expect(page.locator('#viewer-copy')).toBeHidden();
  await page.locator('#viewer-close').click();
  await page.locator('.output-file', { hasText: 'drawing.svg' }).click();
  await expect.poll(() => page.locator('.viewer-image').evaluate((img) => img.complete && img.naturalWidth)).toBe(20);
  await page.locator('#viewer-source').click();
  await expect(page.locator('.viewer-text')).toHaveValue(/<circle/);
  await page.locator('#viewer-close').click();

  // Binary outside the working directory: hex view, nothing to copy or add.
  await page.locator('.output-file', { hasText: '/tmp/data.bin' }).click();
  await expect(page.locator('.viewer-hex')).toHaveText('00000000  00 00 00 2a                                         |...*|');
  await expect(page.locator('#viewer-add')).toBeHidden();
  await page.locator('#viewer-close').click();

  // The next run clears the bar; a program without file output shows none.
  await page.locator('#file-list button[data-path="Main.java"]').click();
  await page.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.press('Delete');
  await page.keyboard.insertText('public class Main { public static void main(String[] a) { System.out.println("quiet"); } }');
  await page.locator('#run').click();
  await expect(page.locator('#output')).toHaveText('quiet\n', { timeout: 60_000 });
  await expect(bar).toBeHidden();
  expect(violations).toEqual([]);
});

test('F3: after Stop the files are captured as they were; limits apply', async ({ page }) => {
  await page.goto('/');
  await ready(page);
  await importProject(page, {
    'Main.java': `import java.io.*;
import java.nio.file.*;

public class Main {
    public static void main(String[] args) throws Exception {
        Files.createDirectories(Path.of("out"));
        for (int i = 0; i < 60; i++) Files.writeString(Path.of(String.format("out/f%02d.txt", i)), "line " + i + "\\n");
        Files.write(Path.of("big.txt"), "x".repeat(2 << 20).getBytes());
        PrintWriter buffered = new PrintWriter("a-pending.txt");
        buffered.println("still in the buffer");
        System.out.println("looping");
        while (true) Thread.onSpinWait();
    }
}`,
  });
  await page.locator('#run').click();
  await expect(page.locator('#output')).toHaveText('looping\n', { timeout: 60_000 });
  await page.locator('#run').click(); // Stop
  await expect(page.locator('#status')).toHaveAttribute('data-state', 'ready');
  await expect(page.locator('#output-files-title')).toHaveText('Files written · 62 · as they were when the program was stopped');
  await expect(page.locator('.output-file')).toHaveCount(50);
  await expect(page.locator('.output-files-more')).toHaveText('+ 12 more');
  await expect(page.locator('.output-file-name').nth(0)).toHaveText('a-pending.txt');
  await expect(page.locator('.output-file-facts').nth(0)).toHaveText('empty');
  await expect(page.locator('.output-file-name').nth(1)).toHaveText('big.txt');
  await expect(page.locator('.output-file-facts').nth(1)).toHaveText('text · 2 MB · truncated');

  // Collapse to the header line.
  await page.locator('#output-files-toggle').click();
  await expect(page.locator('#output-files-list')).toBeHidden();
  await expect(page.locator('#output-files-toggle')).toHaveAttribute('aria-expanded', 'false');
});

test('F3: audio plays in the viewer; text is copied exactly', async ({ page, context, browserName }) => {
  if (browserName === 'chromium') await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/');
  await ready(page);
  await importProject(page, {
    'Main.java': `import java.io.*;
import java.nio.*;
import java.nio.file.*;

public class Main {
    public static void main(String[] args) throws Exception {
        int rate = 8000, n = 4000;                       // half a second of a 440 Hz tone
        ByteBuffer b = ByteBuffer.allocate(44 + 2 * n).order(ByteOrder.LITTLE_ENDIAN);
        b.put("RIFF".getBytes()).putInt(36 + 2 * n).put("WAVEfmt ".getBytes()).putInt(16)
         .putShort((short) 1).putShort((short) 1).putInt(rate).putInt(2 * rate).putShort((short) 2).putShort((short) 16)
         .put("data".getBytes()).putInt(2 * n);
        for (int i = 0; i < n; i++) b.putShort((short) (8000 * Math.sin(2 * Math.PI * 440 * i / rate)));
        Files.write(Path.of("tone.wav"), b.array());
        Files.writeString(Path.of("tabs.txt"), "\\tindented café €\\nline two");
    }
}`,
  });
  await page.locator('#run').click();
  await expect(page.locator('.output-file')).toHaveCount(2, { timeout: 60_000 });
  await expect(page.locator('.output-file-facts').nth(1)).toHaveText('WAV audio · 7.9 KB');
  await page.locator('.output-file', { hasText: 'tone.wav' }).click();
  await expect(page.locator('.viewer-audio')).toBeVisible();
  await expect.poll(() => page.locator('.viewer-audio').evaluate((a) => a.duration), { timeout: 10_000 }).toBeCloseTo(0.5, 1);
  await page.locator('#viewer-close').click();

  await page.locator('.output-file', { hasText: 'tabs.txt' }).click();
  await expect(page.locator('.viewer-text')).toHaveValue('\tindented café €\nline two');
  if (browserName === 'chromium') {
    await page.locator('#viewer-copy').click();
    await expect(page.locator('#viewer-message')).toHaveText('Copied.');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('\tindented café €\nline two');
  }
});

test('F3: a PDF opens in the browser viewer where there is one, otherwise as bytes', async ({ page }) => {
  const violations = [];
  page.on('console', (m) => { if (/Content.Security.Policy/i.test(m.text()) && !/Ignoring ‘x-frame-options’/.test(m.text())) violations.push(m.text()); });
  await page.goto('/');
  await ready(page);
  await importProject(page, {
    'Main.java': `import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;

public class Main {
    public static void main(String[] args) throws Exception {
        String[] objects = {
            "<< /Type /Catalog /Pages 2 0 R >>",
            "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
            "<< /Length 44 >>\\nstream\\nBT /F1 24 Tf 40 70 Td (Hello, PDF) Tj ET\\nendstream",
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        };
        StringBuilder pdf = new StringBuilder("%PDF-1.4\\n");
        List<Integer> offsets = new ArrayList<>();
        for (int i = 0; i < objects.length; i++) {
            offsets.add(pdf.length());
            pdf.append(i + 1).append(" 0 obj\\n").append(objects[i]).append("\\nendobj\\n");
        }
        int xref = pdf.length();
        pdf.append("xref\\n0 ").append(objects.length + 1).append("\\n0000000000 65535 f \\n");
        for (int o : offsets) pdf.append(String.format("%010d 00000 n \\n", o));
        pdf.append("trailer\\n<< /Size ").append(objects.length + 1).append(" /Root 1 0 R >>\\nstartxref\\n").append(xref).append("\\n%%EOF\\n");
        Files.write(Path.of("hello.pdf"), pdf.toString().getBytes(StandardCharsets.US_ASCII));
    }
}`,
  });
  await page.locator('#run').click();
  await expect(page.locator('.output-file-facts')).toHaveText(/^PDF document · \d+ B$/, { timeout: 60_000 });
  await page.locator('.output-file').click();
  const viewer = await page.evaluate(() => navigator.pdfViewerEnabled === true);
  if (viewer) {
    await expect(page.locator('.viewer-pdf')).toBeVisible();
    await page.waitForTimeout(1500); // let the viewer load
  } else {
    await expect(page.locator('.viewer-hex')).toContainText('|%PDF-1.4.');
  }
  await expect(page.locator('#viewer-copy')).toBeHidden();
  expect(violations).toEqual([]);
  console.log(`pdfViewerEnabled=${viewer}`);
});
