// Program arguments typed on the console's command line ("$ java Main …"). Because the
// line is presented as a shell prompt, it is split with POSIX shell quoting, so a line
// means here what it means in a terminal:
//   - outside quotes, \ escapes the next character (`a\ b` is one argument);
//   - '…' is literal (backslashes too);
//   - "…" is literal except \" \\ \$ \` (other backslashes are kept, as in bash).
// Shell features Kopje doesn't have (pipes, redirects, ;, &, subshells, $VAR, `cmd`,
// # comments) are rejected when unquoted rather than silently passed on as text. Globs
// (*, ?), braces and ~ are not expanded: they stay as typed, as in a folder with no match.

export const MAX_ARGS_CHARS = 1000;
export const MAX_ARGS = 100;

const UNSUPPORTED: Record<string, string> = {
  '|': 'a pipe (|)', '>': 'redirection (>)', '<': 'redirection (<)', ';': 'running several commands (;)',
  '&': 'running in the background (&)', '(': 'a subshell ( )', ')': 'a subshell ( )',
  '`': 'command substitution (`)', '$': 'a variable ($)', '#': 'a comment (#)',
};
const unsupported = (c: string) =>
  new Error(`Arguments: ${UNSUPPORTED[c]} isn't supported here; write '${c}' or \\${c} to pass ${c} as text`);

/** @throws Error with a user-readable message (unclosed quote, unsupported syntax, too long). */
export function parseArgs(line: string): string[] {
  if (line.length > MAX_ARGS_CHARS) throw new Error(`Arguments are too long (max ${MAX_ARGS_CHARS} characters)`);
  const out: string[] = [];
  let cur = '';
  let inArg = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '\\') {
      if (i + 1 >= line.length) throw new Error('Arguments: nothing after the final \\');
      cur += line[++i];
      inArg = true;
    } else if (c === '\'') {
      const end = line.indexOf('\'', i + 1);
      if (end < 0) throw new Error("Arguments: closing ' missing");
      cur += line.slice(i + 1, end);
      i = end;
      inArg = true;
    } else if (c === '"') {
      let j = i + 1;
      for (;; j++) {
        if (j >= line.length) throw new Error('Arguments: closing " missing');
        const d = line[j];
        if (d === '"') break;
        if (d === '\\' && '"\\$`'.includes(line[j + 1] ?? '')) { cur += line[++j]; continue; }
        if (d === '$' || d === '`') throw unsupported(d);
        cur += d;
      }
      i = j;
      inArg = true;
    } else if (/\s/.test(c)) {
      if (inArg) out.push(cur);
      cur = '';
      inArg = false;
    } else if (c in UNSUPPORTED && (c !== '#' || !inArg)) {
      throw unsupported(c); // '#' only starts a comment at the beginning of a word
    } else {
      cur += c;
      inArg = true;
    }
  }
  if (inArg) out.push(cur);
  if (out.length > MAX_ARGS) throw new Error(`Too many arguments (max ${MAX_ARGS})`);
  return out;
}
