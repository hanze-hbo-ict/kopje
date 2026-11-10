import type { RunResult, RuntimeEvent, SourceMap } from './runtime-protocol.ts';

/**
 * Runtime-independent execution API (PLAN.md §5). compile and run are a single
 * operation here: every run compiles all files in a fresh, disposable JVM, so
 * stale bytecode can never execute.
 */
export interface JavaEngine {
  /** Pre-boot a runtime so the first run does not pay JVM + javac warm-up. */
  initialize(): Promise<void>;
  /** Compile all files together and run mainClass. One run at a time. */
  run(files: SourceMap, mainClass: string, onEvent: (event: RuntimeEvent) => void): Promise<RunResult>;
  /** Deliver text to stdin; the caller appends '\n' per line. Control characters are stripped. */
  sendInput(text: string): void;
  /** Signal end of input (Ctrl+D). */
  sendEof(): void;
  /** Tear down the running JVM context. Safe at any time. */
  stop(): Promise<void>;
  readonly running: boolean;
  dispose(): Promise<void>;
}
