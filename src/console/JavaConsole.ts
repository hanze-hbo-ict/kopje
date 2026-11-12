// Console transcript. Interaction model from Klode (src/output.js, src/input.js; MIT,
// © 2026 Codeklad contributors): output batched per animation frame into one transcript,
// stdin as a borderless input inline after the prompt, errors in a separate alert.
import type { CompilerDiagnostic } from '../runtime/runtime-protocol.ts';

type Stream = 'stdout' | 'stderr' | 'input';

export interface ConsoleElements {
  body: HTMLElement;        // scroll container (.console-body)
  output: HTMLElement;      // transcript (#output)
  form: HTMLFormElement;    // inline input form
  answer: HTMLInputElement; // inline input
  notes: HTMLElement;       // status lines + diagnostics
  error: HTMLElement;       // role=alert
}

export class JavaConsole {
  private queue: { stream: Stream; text: string }[] = [];
  private frame: number | null = null;
  private onLine: ((line: string) => void) | null = null;
  private onEof: (() => void) | null = null;

  private readonly el: ConsoleElements;

  constructor(el: ConsoleElements) {
    this.el = el;
    el.form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!this.onLine) return;
      const line = el.answer.value;
      const cb = this.onLine;
      this.hideInput();
      this.append('input', line + '\n');
      this.flush();
      cb(line);
    });
    el.answer.addEventListener('keydown', (e) => {
      if (e.key === 'd' && e.ctrlKey && !e.altKey && !e.metaKey && this.onEof) {
        e.preventDefault();
        const cb = this.onEof;
        const partial = el.answer.value;
        this.hideInput();
        if (partial) this.append('input', partial);
        this.flush();
        cb();
      }
    });
    el.answer.addEventListener('input', () => this.resize());
    // Clicking anywhere in an empty part of the console focuses a pending input.
    el.body.addEventListener('mouseup', () => {
      if (!el.form.hidden && !getSelection()?.toString()) el.answer.focus({ preventScroll: true });
    });
  }

  clear() {
    this.queue = [];
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    this.el.output.textContent = '';
    this.el.notes.textContent = '';
    this.error('');
    this.hideInput();
  }

  append(stream: Stream, text: string) {
    if (!text) return;
    this.queue.push({ stream, text });
    if (this.frame === null) this.frame = requestAnimationFrame(() => this.flush());
  }

  flush() {
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    if (!this.queue.length) return;
    const atBottom = this.isAtBottom();
    const out = this.el.output;
    for (const { stream, text } of this.queue.splice(0)) {
      const last = out.lastElementChild as HTMLElement | null;
      if (last && last.dataset.stream === stream) last.append(text);
      else {
        const span = document.createElement('span');
        span.dataset.stream = stream;
        span.className = `out-${stream}`;
        span.textContent = text;
        out.append(span);
      }
    }
    if (atBottom) this.reveal();
  }

  private isAtBottom() {
    const b = this.el.body;
    return b.scrollHeight - b.scrollTop - b.clientHeight < 40;
  }

  reveal() {
    this.el.body.scrollTop = this.el.body.scrollHeight;
  }

  /** Show the inline input after the current output. */
  requestInput(onLine: (line: string) => void, onEof: () => void) {
    this.flush();
    this.onLine = onLine;
    this.onEof = onEof;
    if (this.el.form.hidden) {
      this.el.answer.value = '';
      this.el.form.hidden = false;
    }
    this.resize();
    this.el.answer.focus({ preventScroll: true });
    this.reveal();
  }

  hideInput() {
    this.onLine = null;
    this.onEof = null;
    this.el.answer.value = '';
    this.el.form.hidden = true;
  }

  get inputVisible() { return !this.el.form.hidden; }

  private resize() {
    this.el.answer.style.width = `${Math.max(8, this.el.answer.value.length + 1)}ch`;
  }

  /** A muted line below the transcript, e.g. "Exited with status 3." */
  note(text: string) {
    this.flush();
    const p = document.createElement('p');
    p.className = 'console-note';
    p.textContent = text;
    this.el.notes.append(p);
    this.reveal();
  }

  diagnostics(list: CompilerDiagnostic[], open: (d: CompilerDiagnostic) => void) {
    this.flush();
    const errors = list.filter((d) => d.severity === 'error').length;
    const heading = document.createElement('p');
    heading.className = 'console-note diag-heading';
    heading.textContent = errors === 1 ? 'Compilation failed: 1 error' : `Compilation failed: ${errors} errors`;
    const ul = document.createElement('ul');
    ul.className = 'diagnostics';
    ul.setAttribute('aria-label', 'Compiler messages');
    for (const d of list) {
      const li = document.createElement('li');
      const loc = d.file ? `${d.file}:${d.line}${d.column ? ':' + d.column : ''}` : '';
      const btn = document.createElement(d.file ? 'button' : 'span');
      btn.className = `diag diag-${d.severity}`;
      if (btn instanceof HTMLButtonElement) {
        btn.type = 'button';
        btn.title = `Open ${loc}`;
        btn.addEventListener('click', () => open(d));
      }
      const where = document.createElement('span');
      where.className = 'diag-loc';
      where.textContent = loc ? `${loc}  ` : '';
      const sev = document.createElement('span');
      sev.className = 'diag-sev';
      sev.textContent = d.severity === 'error' ? 'error: ' : 'warning: ';
      const msg = document.createElement('span');
      msg.textContent = d.message;
      btn.append(where, sev, msg);
      li.append(btn);
      ul.append(li);
    }
    this.el.notes.append(heading, ul);
    this.reveal();
    return ul.querySelector('button');
  }

  error(text: string) {
    this.flush();
    this.el.error.textContent = text;
    this.el.error.hidden = !text;
  }
}
