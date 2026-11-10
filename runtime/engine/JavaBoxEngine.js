// JavaBoxEngine — JavaEngine implementation over disposable runtime iframes.
//
// Isolation/termination model (see docs/architecture.md):
//   * one iframe == one JVM == one compile+run. Never reused.
//   * stop()/timeout/output-cap => iframe.remove(). Removing the document destroys
//     its Emscripten pthread Workers and the WASM memory with it.
//   * after each run a fresh iframe is pre-booted, so the next Run does not pay
//     JVM + javac warm-up latency.
//
// RuntimeEvent kinds: initializing, ready, compiling, compiled, running,
//   waiting-for-input, input-consumed, stdout, stderr, output-limit, exit,
//   error, stopped, timeout, log

import { validateFiles, isValidMainClass, sanitizeInput } from './paths.js';

const DEFAULTS = {
  runtimeUrl: new URL('../host/runtime.html', import.meta.url).href,
  bootTimeoutMs: 120_000,
  runTimeoutMs: 120_000,       // wall clock, excludes time spent waiting for stdin
  outputCap: 1_000_000,        // bytes of stdout+stderr per run
  prewarm: true,
};

class RuntimeContext {
  constructor(opts, onEvent) {
    this.opts = opts;
    this.onEvent = onEvent;
    this.iframe = document.createElement('iframe');
    this.iframe.hidden = true;
    this.iframe.title = 'Java runtime';
    const url = new URL(opts.runtimeUrl);
    url.searchParams.set('outputCap', String(opts.outputCap));
    this.iframe.src = url.href;
    this.readyPromise = new Promise((resolve, reject) => { this._ready = resolve; this._fail = reject; });
    this.readyPromise.catch(() => {});
    this.listener = (e) => this.handle(e);
    addEventListener('message', this.listener);
    this.bootTimer = setTimeout(() => this._fail(new Error('Java runtime did not start in time')), opts.bootTimeoutMs);
    this.createdAt = performance.now();
    document.body.appendChild(this.iframe);
  }

  handle(e) {
    if (e.source !== this.iframe.contentWindow || e.origin !== location.origin) return;
    const m = e.data;
    if (!m || m.type !== 'event' || !m.event || typeof m.event.kind !== 'string') return;
    const ev = m.event;
    if (ev.kind === 'ready') {
      clearTimeout(this.bootTimer);
      this.readyMs = Math.round(performance.now() - this.createdAt);
      this._ready();
    } else if (ev.kind === 'error' && !this.readyMs) {
      clearTimeout(this.bootTimer);
      this._fail(new Error(ev.message));
    }
    this.onEvent(ev);
  }

  send(msg) { this.iframe.contentWindow?.postMessage(msg, location.origin); }

  destroy() {
    clearTimeout(this.bootTimer);
    removeEventListener('message', this.listener);
    this.iframe.src = 'about:blank';
    this.iframe.remove();
    this.onEvent = () => {};
  }
}

export class JavaBoxEngine {
  constructor(options = {}) {
    this.opts = { ...DEFAULTS, ...options };
    this.spare = null;       // pre-booted context awaiting a run
    this.active = null;      // { ctx, onEvent, resolve, ... }
    this.disposed = false;
  }

  /** Boot (or re-boot) a spare runtime. Resolves when the JVM + javac are warm. */
  async initialize() {
    this._ensureSpare();
    await this.spare.readyPromise;
  }

  _ensureSpare() {
    if (this.disposed || this.spare) return;
    const ctx = new RuntimeContext(this.opts, (ev) => { if (ev.kind === 'log') console.debug('[runtime]', ev.message); });
    ctx.readyPromise.catch(() => { if (this.spare === ctx) { ctx.destroy(); this.spare = null; } });
    this.spare = ctx;
  }

  get running() { return !!this.active; }

  /**
   * Compile all files together and run mainClass in a fresh JVM.
   * Resolves with { status: 'exit'|'compile-error'|'stopped'|'timeout'|'output-limit'|'error', code? }.
   */
  async run(files, mainClass, onEvent) {
    if (this.disposed) throw new Error('Engine disposed');
    if (this.active) throw new Error('A program is already running');
    const valid = validateFiles(files);
    if (!isValidMainClass(mainClass)) throw new Error(`Invalid main class: ${mainClass}`);

    let settle;
    const done = new Promise((r) => { settle = r; });
    const run = { onEvent, settle, finished: false, waiting: false, startedAt: 0, waitedMs: 0, waitStart: 0, timer: 0 };
    this.active = run;

    this._ensureSpare();
    const ctx = this.spare;
    this.spare = null;
    run.ctx = ctx;
    onEvent({ kind: 'initializing' });
    ctx.onEvent = (ev) => this._onRunEvent(run, ev);
    try {
      await ctx.readyPromise;
    } catch (err) {
      this._finish(run, { status: 'error', message: err.message }, { kind: 'error', errorKind: 'boot', message: err.message });
      return done;
    }
    if (run.finished) return done;   // stopped while booting
    run.startedAt = performance.now();
    this._armTimeout(run);
    ctx.send({ type: 'start', files: valid, mainClass });
    return done;
  }

  _armTimeout(run) {
    clearTimeout(run.timer);
    if (run.waiting) return;   // time blocked on stdin does not count
    const used = performance.now() - run.startedAt - run.waitedMs;
    run.timer = setTimeout(() => {
      this._finish(run, { status: 'timeout' }, { kind: 'timeout', limitMs: this.opts.runTimeoutMs });
    }, Math.max(0, this.opts.runTimeoutMs - used));
  }

  _onRunEvent(run, ev) {
    if (run.finished) return;
    switch (ev.kind) {
      case 'ready': return;   // already consumed via readyPromise
      case 'waiting-for-input':
        if (!run.waiting) { run.waiting = true; run.waitStart = performance.now(); clearTimeout(run.timer); }
        break;
      case 'input-consumed':
        if (run.waiting) { run.waiting = false; run.waitedMs += performance.now() - run.waitStart; this._armTimeout(run); }
        break;
      case 'compiled':
        run.onEvent(ev);
        if (!ev.ok) this._finish(run, { status: 'compile-error', diagnostics: ev.diagnostics });
        return;
      case 'output-limit':
        this._finish(run, { status: 'output-limit' }, ev);
        return;
      case 'exit':
        this._finish(run, { status: 'exit', code: ev.code }, ev);
        return;
      case 'error':
        // Driver-reported errors (no-main-method, …) are followed by exit; runtime
        // failures (abort, boot) are terminal.
        if (['abort', 'boot', 'fatal', 'not-isolated'].includes(ev.errorKind)) {
          this._finish(run, { status: 'error', message: ev.message }, ev);
          return;
        }
        break;
    }
    run.onEvent(ev);
  }

  _finish(run, result, finalEvent) {
    if (run.finished) return;
    run.finished = true;
    clearTimeout(run.timer);
    if (finalEvent) run.onEvent(finalEvent);
    run.ctx?.destroy();
    if (this.active === run) this.active = null;
    if (this.opts.prewarm) this._ensureSpare();
    run.settle(result);
  }

  /** Deliver text to the running program's stdin. The caller adds '\n' per line. */
  sendInput(text) {
    const run = this.active;
    if (!run || run.finished || !run.ctx) return;
    const clean = sanitizeInput(text);
    if (clean) run.ctx.send({ type: 'stdin', text: clean });
  }

  /** Signal end-of-input (Ctrl-D). */
  sendEof() {
    const run = this.active;
    if (run && !run.finished && run.ctx) run.ctx.send({ type: 'eof' });
  }

  /** Tear down the running JVM context. Safe to call at any time. */
  async stop() {
    const run = this.active;
    if (!run) return;
    this._finish(run, { status: 'stopped' }, { kind: 'stopped' });
  }

  async dispose() {
    this.disposed = true;
    await this.stop();
    this.spare?.destroy();
    this.spare = null;
  }
}
