// Finds the classes in a source file that declare a launchable main method, for the
// main-class menu. A light scanner, not a parser: it blanks out comments and literals,
// tracks type nesting by braces, and accepts the classic JDK 21 launcher entry point
// `public static void main(String[] args)` (also `String... args` and `String args[]`).
// Interface members count as public. Local and anonymous classes are skipped because
// they can't be launched by name.

export interface MainEntry {
  /** Binary name for Class.forName, e.g. "shop.Main" or "shop.Outer$Inner". */
  className: string;
  /** Source-style name for display, e.g. "shop.Outer.Inner". */
  label: string;
  /** Project path of the file that declares it. */
  path: string;
}

/** Replace comments, string/char literals and text blocks with spaces (newlines kept). */
function blank(src: string): string {
  let out = '';
  let i = 0;
  const n = src.length;
  const keep = (s: string) => s.replace(/[^\n]/g, ' ');
  while (i < n) {
    const c = src[i], d = src[i + 1];
    let end = -1;
    if (c === '/' && d === '/') {
      end = src.indexOf('\n', i);
      if (end < 0) end = n;
    } else if (c === '/' && d === '*') {
      end = src.indexOf('*/', i + 2);
      end = end < 0 ? n : end + 2;
    } else if (c === '"' && src.startsWith('"""', i)) {
      end = i + 3;
      while (end < n && !src.startsWith('"""', end)) end += src[end] === '\\' ? 2 : 1;
      end = Math.min(n, end + 3);
    } else if (c === '"' || c === '\'') {
      end = i + 1;
      while (end < n && src[end] !== c && src[end] !== '\n') end += src[end] === '\\' ? 2 : 1;
      end = Math.min(n, end + 1);
    }
    if (end < 0) { out += c; i++; continue; }
    out += keep(src.slice(i, end));
    i = end;
  }
  return out;
}

const TOKEN = /[A-Za-z_$À-￿][\w$À-￿]*|\.\.\.|[{}()[\];.,<>@=]|\S/g;
const TYPE_KEYWORDS = new Set(['class', 'interface', 'enum', 'record']);

interface Scope { kind: 'type' | 'block'; name?: string; isInterface?: boolean; launchable?: boolean }

export function findMains(path: string, source: string): MainEntry[] {
  const text = blank(source);
  const pkgMatch = /\bpackage\s+([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*;/.exec(text);
  const pkg = pkgMatch ? pkgMatch[1].replace(/\s+/g, '') : '';
  const tokens = text.match(TOKEN) ?? [];

  const stack: Scope[] = [];
  let pending: Scope | null = null;
  const found: MainEntry[] = [];
  const typeNames = () => stack.filter((s) => s.kind === 'type').map((s) => s.name!);

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (TYPE_KEYWORDS.has(t) && tokens[i - 1] !== '.' && /^[A-Za-z_$À-￿]/.test(tokens[i + 1] ?? '')) {
      // `record` is contextual: only a declaration when followed by Name( or Name<.
      if (t === 'record' && !['(', '<'].includes(tokens[i + 2])) continue;
      const parentOk = stack.length === 0 || (stack[stack.length - 1].kind === 'type' && stack[stack.length - 1].launchable);
      pending = { kind: 'type', name: tokens[i + 1], isInterface: t === 'interface', launchable: parentOk };
      i++;
      continue;
    }
    if (t === '{') { stack.push(pending ?? { kind: 'block' }); pending = null; continue; }
    if (t === '}') { stack.pop(); pending = null; continue; }
    if (t === ';') { pending = null; continue; }

    const scope = stack[stack.length - 1];
    if (t === 'main' && tokens[i + 1] === '(' && tokens[i - 1] === 'void' && scope?.kind === 'type' && scope.launchable) {
      if (!isMainSignature(tokens, i, scope.isInterface === true)) continue;
      const names = typeNames();
      const prefix = pkg ? pkg + '.' : '';
      const entry = { className: prefix + names.join('$'), label: prefix + names.join('.'), path };
      if (!found.some((f) => f.className === entry.className)) found.push(entry);
    }
  }
  return found;
}

/** tokens[i] is `main`, preceded by `void` and followed by `(`. */
function isMainSignature(tokens: string[], i: number, inInterface: boolean): boolean {
  // Modifiers: walk back from `void` to the previous member boundary.
  const mods = new Set<string>();
  for (let j = i - 2; j >= 0 && !['{', '}', ';'].includes(tokens[j]); j--) mods.add(tokens[j]);
  if (!mods.has('static')) return false;
  if (!mods.has('public') && !inInterface) return false;
  if (mods.has('private') || mods.has('protected')) return false;

  // Parameters: up to the matching `)`.
  const params: string[] = [];
  let depth = 0;
  for (let j = i + 1; j < tokens.length; j++) {
    const t = tokens[j];
    if (t === '(') { if (depth++ === 0) continue; }
    if (t === ')' && --depth === 0) break;
    params.push(t);
  }
  // Drop `final` and simple annotations such as @SuppressWarnings("x").
  const cleaned: string[] = [];
  for (let k = 0; k < params.length; k++) {
    if (params[k] === 'final') continue;
    if (params[k] === '@') {
      k++;
      while (params[k + 1] === '.') k += 2;
      if (params[k + 1] === '(') { let d = 0; do { k++; if (params[k] === '(') d++; else if (params[k] === ')') d--; } while (k < params.length && d > 0); }
      continue;
    }
    cleaned.push(params[k]);
  }
  const sig = cleaned.join(' ');
  return /^(?:java \. lang \. )?String (?:\[ \] |\.\.\. )[A-Za-z_$À-￿][\w$À-￿]*$/.test(sig)
    || /^(?:java \. lang \. )?String [A-Za-z_$À-￿][\w$À-￿]* \[ \]$/.test(sig);
}
