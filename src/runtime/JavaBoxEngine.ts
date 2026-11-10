// JavaBoxEngine — JavaEngine over disposable runtime iframes (docs/architecture.md ADR-2).
//
//   * one iframe == one JVM == one compile+run; never reused
//   * stop() / timeout / output cap => iframe.remove(), which destroys the document's
//     Emscripten pthread Workers and WASM memory
//   * after each run a fresh iframe is pre-booted so the next Run skips JVM + javac warm-up

import { validateFiles, isValidMainClass, sanitizeInput } from '../project/paths.ts';
import type { JavaEngine } from './JavaEngine.ts';
import type { HostCommand, RunResult, RuntimeEvent, SourceMap } from './runtime-protocol.ts';
import { RUNTIME_PATH } from './runtime-location.generated.ts';

export interface EngineOptions {
  runtimeUrl: string;
  bootTimeoutMs: number;
  /** Wall-clock limit for one run, excluding time blocked waiting for stdin. */
  runTimeoutMs: number;
  /** Bytes of stdout+stderr per run before the run is torn down. */
  outputCap: number;
  prewarm: boolean;
}

/** E6: one runtime is ~400 MB resident; on small devices don't keep a second one ready. */
function lowMemoryDevice(): boolean {
  const gb = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  return typeof gb === 'number' && gb <= 4;
}

const DEFAULTS: EngineOptions = {
  // Content-versioned path (scripts/prepare-runtime.mjs), so the runtime can be cached immutably.
  runtimeUrl: new URL(RUNTIME_PATH, document.baseURI).href,
  bootTimeoutMs: 120_000,
  runTimeoutMs: 120_000,
  outputCap: 1_000_000,
  prewarm: !lowMemoryDevice(),
};

const TERMINAL_ERRORS = new Set(['abort', 'boot', 'fatal', 'not-isolated', 'stack-overflow']);

class RuntimeContext {
  readonly iframe: HTMLIFrameElement;
  readonly ready: Promise<void>;
  onEvent: (ev: RuntimeEvent) => void;
  private resolveReady!: () => void;
  private rejectReady!: (e: Error) => void;
  private readyAt = 0;
  private readonly bootTimer: ReturnType<typeof setTimeout>;
  private readonly listener = (e: MessageEvent) => this.handle(e);

  constructor(opts: EngineOptions, onEvent: (ev: RuntimeEvent) => void) {
    this.onEvent = onEvent;
    this.ready = new Promise<void>((res, rej) => { this.resolveReady = res; this.rejectReady = rej; });
    this.ready.catch(() => {});
    this.iframe = document.createElement('iframe');
    this.iframe.hidden = true;
    this.iframe.title = 'Java runtime';
    this.iframe.setAttribute('aria-hidden', 'true');
    this.iframe.tabIndex = -1;
    const url = new URL(opts.runtimeUrl);
    url.searchParams.set('outputCap', String(opts.outputCap));
    this.iframe.src = url.href;
    addEventListener('message', this.listener);
    this.bootTimer = setTimeout(() => this.rejectReady(new Error('The Java runtime did not start in time.')), opts.bootTimeoutMs);
    document.body.appendChild(this.iframe);
  }

  private handle(e: MessageEvent) {
    if (e.source !== this.iframe.contentWindow || e.origin !== location.origin) return;
    const m = e.data as { type?: unknown; event?: { kind?: unknown } } | null;
    if (!m || m.type !== 'event' || !m.event || typeof m.event.kind !== 'string') return;
    const ev = m.event as RuntimeEvent;
    if (ev.kind === 'ready') {
      clearTimeout(this.bootTimer);
      this.readyAt = performance.now();
      this.resolveReady();
    } else if (ev.kind === 'error' && !this.readyAt) {
      clearTimeout(this.bootTimer);
      this.rejectReady(new Error(ev.message));
    }
    this.onEvent(ev);
  }

  send(msg: HostCommand) { this.iframe.contentWindow?.postMessage(msg, location.origin); }

  destroy() {
    clearTimeout(this.bootTimer);
    removeEventListener('message', this.listener);
    this.onEvent = () => {};
    this.iframe.src = 'about:blank';
    this.iframe.remove();
  }
}

interface ActiveRun {
  ctx?: RuntimeContext;
  onEvent: (ev: RuntimeEvent) => void;
  settle: (r: RunResult) => void;
  finished: boolean;
  waiting: boolean;
  startedAt: number;
  waitedMs: number;
  waitStart: number;
  timer?: ReturnType<typeof setTimeout>;
}

export class JavaBoxEngine implements JavaEngine {
  private readonly opts: EngineOptions;
  /** Whether a spare runtime is kept ready after each run (false on low-memory devices). */
  get prewarming() { return this.opts.prewarm; }
  private spare: RuntimeContext | null = null;
  private active: ActiveRun | null = null;
  private disposed = false;

  constructor(options: Partial<EngineOptions> = {}) {
    this.opts = { ...DEFAULTS, ...options };
  }

  get running() { return this.active !== null; }

  async initialize() {
    this.ensureSpare();
    await this.spare!.ready;
  }

  private ensureSpare() {
    if (this.disposed || this.spare) return;
    const ctx = new RuntimeContext(this.opts, (ev) => { if (ev.kind === 'log') console.debug('[runtime]', ev.message); });
    ctx.ready.catch(() => {
      // A runtime that fails to boot (e.g. memory allocation) stops pre-booting for this session.
      this.opts.prewarm = false;
      if (this.spare === ctx) { ctx.destroy(); this.spare = null; }
    });
    this.spare = ctx;
  }

  async run(files: SourceMap, mainClass: string, onEvent: (ev: RuntimeEvent) => void): Promise<RunResult> {
    if (this.disposed) throw new Error('Engine disposed');
    if (this.active) throw new Error('A program is already running');
    const valid = validateFiles(files);
    if (!isValidMainClass(mainClass)) throw new Error(`Invalid main class: ${mainClass}`);

    let settle!: (r: RunResult) => void;
    const done = new Promise<RunResult>((r) => { settle = r; });
    const run: ActiveRun = { onEvent, settle, finished: false, waiting: false, startedAt: 0, waitedMs: 0, waitStart: 0 };
    this.active = run;

    this.ensureSpare();
    const ctx = this.spare!;
    this.spare = null;
    run.ctx = ctx;
    onEvent({ kind: 'initializing' });
    ctx.onEvent = (ev) => this.onRunEvent(run, ev);
    try {
      await ctx.ready;
    } catch (err) {
      const message = (err as Error).message;
      this.finish(run, { status: 'error', message }, { kind: 'error', errorKind: 'boot', message });
      return done;
    }
    if (run.finished) return done; // stopped while booting
    run.startedAt = performance.now();
    this.armTimeout(run);
    ctx.send({ type: 'start', files: valid, mainClass });
    return done;
  }

  private armTimeout(run: ActiveRun) {
    clearTimeout(run.timer);
    if (run.waiting) return; // time blocked on stdin does not count
    const used = performance.now() - run.startedAt - run.waitedMs;
    run.timer = setTimeout(() => {
      this.finish(run, { status: 'timeout' }, { kind: 'timeout', limitMs: this.opts.runTimeoutMs });
    }, Math.max(0, this.opts.runTimeoutMs - used));
  }

  private onRunEvent(run: ActiveRun, ev: RuntimeEvent) {
    if (run.finished) return;
    switch (ev.kind) {
      case 'ready':
        return;
      case 'waiting-for-input':
        if (!run.waiting) { run.waiting = true; run.waitStart = performance.now(); clearTimeout(run.timer); }
        break;
      case 'input-consumed':
        if (run.waiting) { run.waiting = false; run.waitedMs += performance.now() - run.waitStart; this.armTimeout(run); }
        break;
      case 'compiled':
        run.onEvent(ev);
        if (!ev.ok) this.finish(run, { status: 'compile-error', diagnostics: ev.diagnostics });
        return;
      case 'output-limit':
        this.finish(run, { status: 'output-limit' }, ev);
        return;
      case 'exit':
        this.finish(run, { status: 'exit', code: ev.code }, ev);
        return;
      case 'error':
        if (TERMINAL_ERRORS.has(ev.errorKind)) {
          this.finish(run, { status: 'error', message: ev.message }, ev);
          return;
        }
        break;
    }
    run.onEvent(ev);
  }

  private finish(run: ActiveRun, result: RunResult, finalEvent?: RuntimeEvent) {
    if (run.finished) return;
    run.finished = true;
    clearTimeout(run.timer);
    if (finalEvent) run.onEvent(finalEvent);
    run.ctx?.destroy();
    if (this.active === run) this.active = null;
    if (this.opts.prewarm) this.ensureSpare();
    run.settle(result);
  }

  sendInput(text: string) {
    const run = this.active;
    if (!run || run.finished || !run.ctx) return;
    const clean = sanitizeInput(text);
    if (clean) run.ctx.send({ type: 'stdin', text: clean });
  }

  sendEof() {
    const run = this.active;
    if (run && !run.finished && run.ctx) run.ctx.send({ type: 'eof' });
  }

  async stop() {
    const run = this.active;
    if (run) this.finish(run, { status: 'stopped' }, { kind: 'stopped' });
  }

  async dispose() {
    this.disposed = true;
    await this.stop();
    this.spare?.destroy();
    this.spare = null;
  }
}
