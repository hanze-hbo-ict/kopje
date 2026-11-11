// PLAN.md §16 F3: describing files the program wrote, facts only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeFile, factsLine, formatSize, hexDump } from '../../src/console/fileKind.ts';

const enc = (s) => new TextEncoder().encode(s);
const bytes = (...b) => Uint8Array.from(b);

test('text, empty and line counts', () => {
  assert.equal(describeFile(new Uint8Array()).kind, 'empty');
  const d = describeFile(enc('a\nb\n'));
  assert.deepEqual([d.kind, d.text, d.lines], ['text', 'a\nb\n', 2]);
  assert.equal(describeFile(enc('no newline')).lines, 1);
  assert.equal(describeFile(enc('café €\n')).text, 'café €\n');
  assert.equal(describeFile(enc('﻿bom')).text, 'bom');
});

test('invalid UTF-8 and control characters are binary; a cut-off character in a truncated file is not', () => {
  assert.equal(describeFile(bytes(0xc3, 0x28)).kind, 'binary');
  assert.equal(describeFile(bytes(0x00, 0x00, 0x00, 0x2a)).kind, 'binary', 'DataOutputStream.writeInt(42)');
  assert.equal(describeFile(bytes(0xac, 0xed, 0x00, 0x05)).kind, 'binary', 'ObjectOutputStream header');
  const cut = enc('ab€').subarray(0, 4);
  assert.equal(describeFile(cut).kind, 'binary');
  assert.equal(describeFile(cut, true).kind, 'text');
});

test('images, audio, video by content; SVG is text that shows as an image', () => {
  assert.equal(describeFile(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0)).mime, 'image/png');
  assert.equal(describeFile(bytes(0xff, 0xd8, 0xff, 0xe0)).mime, 'image/jpeg');
  assert.equal(describeFile(enc('GIF89a....')).mime, 'image/gif');
  assert.equal(describeFile(enc('RIFF\0\0\0\0WAVEfmt ')).mime, 'audio/wav');
  assert.equal(describeFile(enc('RIFF\0\0\0\0WEBPVP8 ')).mime, 'image/webp');
  assert.equal(describeFile(enc('\0\0\0\x18ftypmp42')).mime, 'video/mp4');
  assert.equal(describeFile(enc('%PDF-1.4\n%âãÏÓ\n')).kind, 'pdf');
  assert.equal(factsLine(describeFile(enc('%PDF-1.4\n')), 2048), 'PDF document · 2 KB');
  for (const svg of ['<svg xmlns="http://www.w3.org/2000/svg"/>', '<?xml version="1.0"?>\n<!-- c -->\n<svg width="1">']) {
    const d = describeFile(enc(svg));
    assert.equal(d.kind, 'svg', svg);
    assert.equal(d.text, svg);
  }
  assert.equal(describeFile(enc('<svgfoo>')).kind, 'text');
  assert.equal(describeFile(enc('notes about <svg> tags')).kind, 'text');
});

test('facts line and sizes', () => {
  assert.equal(factsLine(describeFile(enc('a\nb\nc\n')), 6), 'text · 3 lines · 6 B');
  assert.equal(factsLine(describeFile(enc('x')), 1), 'text · 1 line · 1 B');
  assert.equal(factsLine(describeFile(new Uint8Array()), 0), 'empty');
  assert.equal(factsLine(describeFile(new Uint8Array()), 0, { changed: true }), 'changed · empty');
  assert.equal(factsLine(describeFile(bytes(0, 1, 2)), 214), 'binary · 214 B');
  assert.equal(factsLine(describeFile(enc('<svg width="1"/>\n')), 17), 'SVG image · 17 B', 'no line count for images');
  assert.equal(factsLine(describeFile(enc('aaa')), 3_000_000, { truncated: true }), 'text · 2.9 MB · truncated');
  assert.deepEqual([formatSize(0), formatSize(1023), formatSize(1024), formatSize(1536), formatSize(10 * 1024), formatSize(5 << 20)],
    ['0 B', '1023 B', '1 KB', '1.5 KB', '10 KB', '5 MB']);
});

test('hex dump', () => {
  assert.equal(hexDump(enc('Hello, world!\n\0\x01AB')),
    '00000000  48 65 6c 6c 6f 2c 20 77  6f 72 6c 64 21 0a 00 01  |Hello, world!...|\n' +
    '00000010  41 42                                             |AB|');
  assert.equal(hexDump(new Uint8Array(100), 32).split('\n').length, 2);
});
