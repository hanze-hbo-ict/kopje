// Messages between the IDE page and the runtime iframe (public/runtime/host/runtime-host.js).

export type SourceMap = Record<string, string>; // project-relative path -> UTF-8 text

export interface CompilerDiagnostic {
  file: string | null;
  line: number;
  column?: number;
  severity: 'error' | 'warning';
  message: string;
}

export type RuntimeErrorKind =
  | 'no-main-class' | 'no-main-method' | 'bad-main-class' | 'no-sources'
  | 'compiler-crash' | 'fatal' | 'abort' | 'boot' | 'not-isolated' | 'stack-overflow';

/** Lifecycle and I/O events delivered to JavaEngine.run's callback. */
export type RuntimeEvent =
  | { kind: 'initializing' }
  | { kind: 'ready' }
  | { kind: 'compiling' }
  | { kind: 'compiled'; ok: boolean; ms: number; diagnostics: CompilerDiagnostic[] }
  | { kind: 'running' }
  | { kind: 'waiting-for-input' }
  | { kind: 'input-consumed' }
  | { kind: 'stdout'; text: string }
  | { kind: 'stderr'; text: string }
  | { kind: 'output-limit'; limit: number }
  | { kind: 'exit'; code: number; source?: 'driver' | 'runtime' }
  | { kind: 'error'; errorKind: RuntimeErrorKind | string; message: string }
  | { kind: 'stopped' }
  | { kind: 'timeout'; limitMs: number }
  | { kind: 'log'; message: string };

export type RunResult =
  | { status: 'exit'; code: number }
  | { status: 'compile-error'; diagnostics: CompilerDiagnostic[] }
  | { status: 'stopped' }
  | { status: 'timeout' }
  | { status: 'output-limit' }
  | { status: 'error'; message: string };

/** Parent -> runtime iframe. */
export type HostCommand =
  | { type: 'start'; files: SourceMap; mainClass: string }
  | { type: 'stdin'; text: string }
  | { type: 'eof' };

/** Runtime iframe -> parent. */
export interface HostEventMessage { type: 'event'; event: RuntimeEvent }
