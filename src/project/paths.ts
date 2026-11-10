// Project-relative source path validation (shared by the IDE and the engine).

export const LIMITS = Object.freeze({
  maxFiles: 200,
  maxFileChars: 200_000,
  maxTotalChars: 2_000_000,
  maxPathLength: 200,
});

const SEGMENT = /^[A-Za-z_$][A-Za-z0-9_$\-]*$/;

/**
 * Normalise a user-supplied path to "a/b/C.java" or throw an Error with a
 * user-readable message. Rejects absolute paths, "..", empty segments,
 * backslashes, non-.java files and characters that cannot form a Java name.
 */
export function normalizePath(input: unknown): string {
  if (typeof input !== 'string') throw new Error('Path must be a string');
  let p = input.trim();
  if (!p) throw new Error('Path is empty');
  if (p.includes('\\')) throw new Error('Use "/" to separate folders');
  if (p.startsWith('/')) throw new Error('Path must be relative to the project');
  p = p.replace(/\/{2,}/g, '/');
  if (p.length > LIMITS.maxPathLength) throw new Error('Path is too long');
  const segs = p.split('/');
  for (const s of segs) {
    if (s === '') throw new Error('Path has an empty folder name');
    if (s === '.' || s === '..') throw new Error('Path may not contain "." or ".."');
  }
  const file = segs[segs.length - 1];
  if (!file.endsWith('.java')) throw new Error('File name must end with .java');
  const base = file.slice(0, -5);
  for (const s of [...segs.slice(0, -1), base]) {
    if (!SEGMENT.test(s)) throw new Error(`"${s}" is not a valid Java name`);
  }
  return p;
}

/** Validate a whole project file map; returns a new normalised map or throws. */
export function validateFiles(files: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = Object.create(null);
  const seen = new Map<string, string>();   // case-folded -> original (MEMFS is case-sensitive, users' minds are not)
  let total = 0;
  const entries = Object.entries(files);
  if (entries.length > LIMITS.maxFiles) throw new Error(`Too many files (max ${LIMITS.maxFiles})`);
  for (const [raw, text] of entries) {
    const p = normalizePath(raw);
    if (typeof text !== 'string') throw new Error(`${p}: content must be text`);
    if (text.length > LIMITS.maxFileChars) throw new Error(`${p} is too large`);
    total += text.length;
    const key = p.toLowerCase();
    if (seen.has(key)) throw new Error(`Duplicate file: ${p} and ${seen.get(key)}`);
    seen.set(key, p);
    out[p] = text;
  }
  if (total > LIMITS.maxTotalChars) throw new Error('Project is too large');
  return out;
}

export function isValidMainClass(name: unknown): name is string {
  return typeof name === 'string' && /^[A-Za-z_$][A-Za-z0-9_$]*(\.[A-Za-z_$][A-Za-z0-9_$]*)*$/.test(name);
}

/** "example/Main.java" -> "example.Main" */
export function pathToClassName(path: string): string {
  return path.replace(/\.java$/, '').split('/').join('.');
}

/** Strip control characters a user cannot meaningfully type; keeps \t and \n.
 *  Guarantees the reserved EOF byte (0x04) can never come from user input. */
export function sanitizeInput(text: string): string {
  return String(text).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
}

/** "example.Main" -> "example/Main.java" */
export function classNameToPath(name: string): string {
  return name.split('.').join('/') + '.java';
}
