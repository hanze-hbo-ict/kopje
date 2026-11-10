// Plain-text project bundle for copy/paste (PLAN.md §14 E1, E2), e.g. into and out of ans.app:
//
//   // File: example/Main.java
//   <content>
//   // File: example/Calculator.java
//   <content>
//
// Lossless: every file's content is followed by exactly one separator "\n", which parsing
// removes again, so a file without a trailing newline round-trips unchanged. A line that is
// exactly "// File: <path>" inside a source would be read as a header (documented).

import { normalizePath, validateFiles } from './paths.ts';

export const HEADER_PREFIX = '// File: ';
const HEADER = /^\/\/ File: (.+?)\s*$/;

export function serializeProject(files: Record<string, string>, paths = Object.keys(files).sort()): string {
  return paths.map((p) => `${HEADER_PREFIX}${p}\n${files[p]}\n`).join('');
}

export function serializeFile(path: string, text: string): string {
  return `${HEADER_PREFIX}${path}\n${text}\n`;
}

/**
 * Parse pasted text into files. Accepts the bundle format, or a single Java source without
 * headers (its path is derived from `package` and the first top-level type).
 * @throws Error with a user-readable message
 */
export function parseBundle(text: string): Record<string, string> {
  const normalized = text.replace(/\r\n?/g, '\n');
  if (!normalized.trim()) throw new Error('Nothing to import: the text is empty.');
  const lines = normalized.split('\n');
  // split() consumes the separator newline before each header; the only extra element is
  // the empty string after the text's final newline (the last file's separator).
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  const headerAt = lines.findIndex((l) => HEADER.test(l));
  if (headerAt === -1) {
    const path = derivePath(normalized);
    return validateFiles({ [path]: normalized });
  }
  if (lines.slice(0, headerAt).some((l) => l.trim())) {
    throw new Error(`Text before the first "${HEADER_PREFIX.trim()}" line; remove it or add a header for it.`);
  }
  const files: Record<string, string> = {};
  let current: string | null = null;
  let body: string[] = [];
  const flush = () => {
    if (current === null) return;
    const content = body.join('\n');
    if (Object.prototype.hasOwnProperty.call(files, current)) throw new Error(`${current} appears twice.`);
    files[current] = content;
  };
  for (let i = headerAt; i < lines.length; i++) {
    const m = HEADER.exec(lines[i]);
    if (m) {
      flush();
      try { current = normalizePath(m[1]); } catch (e) { throw new Error(`Line ${i + 1}: ${(e as Error).message} (${m[1]})`); }
      body = [];
    } else {
      body.push(lines[i]);
    }
  }
  flush();
  return validateFiles(files);
}

/** "package a.b; ... public class Foo" -> "a/b/Foo.java" */
export function derivePath(source: string): string {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
  const pkg = /\bpackage\s+([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*;/.exec(code)?.[1].replace(/\s+/g, '');
  const type = /\b(?:public\s+)?(?:(?:abstract|final|sealed|non-sealed|static|strictfp)\s+)*(?:class|interface|enum|record)\s+([A-Za-z_$][\w$]*)/.exec(code)?.[1];
  if (!type) throw new Error('Could not find a class, interface, enum or record to name the file after. Add a "// File: path/Name.java" line at the top.');
  return normalizePath(`${pkg ? pkg.replace(/\./g, '/') + '/' : ''}${type}.java`);
}
