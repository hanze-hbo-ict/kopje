// Project-relative path validation for sources and data files (shared by the IDE and the engine).

export const LIMITS = Object.freeze({
  maxFiles: 200,
  maxFileChars: 200_000,
  maxTotalChars: 2_000_000,
  maxPathLength: 200,
});

const SEGMENT = /^[A-Za-z_$][A-Za-z0-9_$\-]*$/;
/** Data file and folder names: no spaces, no leading dot or dash, so never "." or "..". */
const DATA_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9_.\-]*$/;

/** True for Java sources; every other project file is a data file (PLAN.md §16 F2). */
export function isJavaPath(path: string): boolean { return path.endsWith('.java'); }

/**
 * Normalise a user-supplied path to "a/b/C.java" (a source) or "data/scores.csv" (a data
 * file), or throw an Error with a user-readable message. Rejects absolute paths, "..",
 * empty segments and backslashes. Sources need folder and file names that form Java
 * names; data files may use letters, digits, "_", "-" and ".", and may not be .class files.
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
  if (/\.(java|class)$/i.test(file) && !isJavaPath(file)) {
    throw new Error(/\.class$/i.test(file) ? 'Compiled .class files cannot be added' : 'Java sources must end with .java (lower case)');
  }
  if (isJavaPath(file)) {
    const base = file.slice(0, -5);
    for (const s of [...segs.slice(0, -1), base]) {
      if (!SEGMENT.test(s)) throw new Error(`"${s}" is not a valid Java name`);
    }
  } else {
    for (const s of segs) {
      if (!DATA_SEGMENT.test(s)) throw new Error(`"${s}": use only letters, digits, "_", "-" and ".", not starting with "." or "-"`);
    }
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
  // A data file can't share its name with a folder ("data" and "data/x.txt"): in the
  // program's working directory one of them would have to be both a file and a folder.
  for (const key of seen.keys()) {
    for (let i = key.indexOf('/'); i >= 0; i = key.indexOf('/', i + 1)) {
      const folder = key.slice(0, i);
      if (seen.has(folder)) throw new Error(`${seen.get(folder)} is both a file and a folder`);
    }
  }
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
