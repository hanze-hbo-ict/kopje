// What a file the program wrote is, judged by its content (PLAN.md §16 F3). Facts only:
// type, lines, size. Never a guess about why a file looks the way it does.

export type FileKind = 'empty' | 'text' | 'svg' | 'image' | 'audio' | 'video' | 'pdf' | 'binary';

export interface FileDescription {
  kind: FileKind;
  /** MIME type for images, audio, video and PDF (and SVG). */
  mime?: string;
  /** Short type name for the facts line, e.g. "PNG image". */
  type: string;
  /** Decoded text for text and SVG files. */
  text?: string;
  lines?: number;
}

const startsWith = (b: Uint8Array, sig: number[], at = 0) => sig.every((x, i) => b[at + i] === x);
const ascii = (b: Uint8Array, from: number, to: number) => String.fromCharCode(...b.subarray(from, to));

/** Magic numbers of the formats a browser can show. */
function sniff(b: Uint8Array): { kind: 'image' | 'audio' | 'video' | 'pdf'; mime: string; type: string } | null {
  if (ascii(b, 0, 5) === '%PDF-') return { kind: 'pdf', mime: 'application/pdf', type: 'PDF document' };
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { kind: 'image', mime: 'image/png', type: 'PNG image' };
  if (startsWith(b, [0xff, 0xd8, 0xff])) return { kind: 'image', mime: 'image/jpeg', type: 'JPEG image' };
  if (ascii(b, 0, 6) === 'GIF87a' || ascii(b, 0, 6) === 'GIF89a') return { kind: 'image', mime: 'image/gif', type: 'GIF image' };
  if (ascii(b, 0, 2) === 'BM' && b.length >= 26) return { kind: 'image', mime: 'image/bmp', type: 'BMP image' };
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP') return { kind: 'image', mime: 'image/webp', type: 'WebP image' };
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WAVE') return { kind: 'audio', mime: 'audio/wav', type: 'WAV audio' };
  if (ascii(b, 0, 4) === 'OggS') return { kind: 'audio', mime: 'audio/ogg', type: 'Ogg audio' };
  if (ascii(b, 0, 4) === 'fLaC') return { kind: 'audio', mime: 'audio/flac', type: 'FLAC audio' };
  if (ascii(b, 0, 3) === 'ID3') return { kind: 'audio', mime: 'audio/mpeg', type: 'MP3 audio' };
  if (ascii(b, 4, 8) === 'ftyp') return { kind: 'video', mime: 'video/mp4', type: 'MP4 video' };
  if (startsWith(b, [0x1a, 0x45, 0xdf, 0xa3])) return { kind: 'video', mime: 'video/webm', type: 'WebM video' };
  return null;
}

const SVG = /^﻿?\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE\s+svg[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i;
// Control characters other than tab, newline, carriage return and form feed mean "not text".
const CONTROL = /[\u0000-\u0008\u000b\u000e-\u001f\u007f]/;

/** `truncated`: bytes are a prefix, so a character cut off at the end is not an error. */
export function describeFile(bytes: Uint8Array, truncated = false): FileDescription {
  if (!bytes.length) return { kind: 'empty', type: 'empty' };
  const media = sniff(bytes);
  if (media) return media;
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: truncated });
  } catch {
    return { kind: 'binary', type: 'binary' };
  }
  if (CONTROL.test(text)) return { kind: 'binary', type: 'binary' };
  text = text.replace(/^﻿/, '');
  const lines = text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  if (SVG.test(text)) return { kind: 'svg', mime: 'image/svg+xml', type: 'SVG image', text, lines };
  return { kind: 'text', type: 'text', text, lines };
}

export function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
  return `${v < 10 ? v.toFixed(1).replace(/\.0$/, '') : Math.round(v)} ${units[u]}`;
}

/** "text · 12 lines · 340 B", "empty", "PNG image · 12 KB · truncated", with "changed" first for existing files. */
export function factsLine(d: FileDescription, size: number, opts: { truncated?: boolean; changed?: boolean } = {}): string {
  const parts: string[] = [];
  if (opts.changed) parts.push('changed');
  if (d.kind === 'empty') { parts.push('empty'); return parts.join(' · '); }
  parts.push(d.type);
  if (d.kind === 'text' && d.lines !== undefined && !opts.truncated) parts.push(d.lines === 1 ? '1 line' : `${d.lines} lines`);
  parts.push(formatSize(size));
  if (opts.truncated) parts.push('truncated');
  return parts.join(' · ');
}

/** Classic hex dump: offset, 16 bytes in hex, printable ASCII. */
export function hexDump(bytes: Uint8Array, limit = 64 * 1024): string {
  const n = Math.min(bytes.length, limit);
  const out: string[] = [];
  for (let off = 0; off < n; off += 16) {
    const row = bytes.subarray(off, Math.min(off + 16, n));
    const hex = Array.from(row, (b) => b.toString(16).padStart(2, '0'));
    const left = hex.slice(0, 8).join(' ').padEnd(23);
    const right = hex.slice(8).join(' ').padEnd(23);
    const chars = Array.from(row, (b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.')).join('');
    out.push(`${off.toString(16).padStart(8, '0')}  ${left}  ${right}  |${chars}|`);
  }
  return out.join('\n');
}
