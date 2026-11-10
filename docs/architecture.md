# Architecture and decisions

```text
IDE page (static)                         runtime iframe (one per run, disposable)
┌──────────────────────────┐   postMessage  ┌───────────────────────────────────────────┐
│ JavaBoxEngine            │ ─────────────▶ │ runtime-host.js                           │
│  · validate paths/limits │ start/stdin/eof│  · preRun: write driver → /opt/javaedit,  │
│  · one run at a time     │ ◀───────────── │    mkdir /work/src, create /dev/jectl     │
│  · timeout, Stop         │    events      │  · stdout/stderr per-byte devices         │
│  · prewarm next iframe   │                │  · bounded writes into stdin ring         │
└──────────────────────────┘                │ JavaBox WASM (PROXY_TO_PTHREAD, 16 Workers)│
                                            │  └ JVM → javaedit CompileServer (driver)  │
                                            │       compile all files → run main → exit │
                                            └───────────────────────────────────────────┘
```

Code: `runtime/java/CompileServer.java` (driver), `runtime/host/` (iframe),
`runtime/engine/` (parent API), `runtime/slice.html` (Gate 2 test page).

## ADR-1 — Replace the driver at runtime, not by relinking (revised after testing)

`jvm-main.c` hard-codes `FindClass("CompileServer")` with class path
`/opt/javabox:/opt/javabox/doom.jar`. The original plan was to pass
`-Djava.class.path=/opt/javaedit` via `Module.arguments`. **Testing showed the prebuilt
ignores `Module.arguments`**, so the runtime host instead:

1. calls `addRunDependency('javaedit-driver')` in `preRun`, which holds back `main()`;
2. waits until the preload package has created `/opt/javabox/CompileServer.class`;
3. unlinks upstream's `CompileServer*.class` and the Doom files, then writes our driver
   classes there;
4. removes the run dependency, and the JVM starts with our driver.

**Consequences:** the driver is named `CompileServer` (default package). It can't receive
`-D` options in the prebuilt, so its property defaults are the browser configuration. No
native rebuild is needed for Phases 1–2. **Verified** in all three engines.

## ADR-2 — One disposable JVM per compile+run, hosted in an iframe

Follows the plan's preferred model. Each run gets a fresh iframe → fresh WASM memory,
MEMFS, pthread Workers, JVM statics. **Stop / timeout / output cap = `iframe.remove()`**,
which terminates the document's Workers including one spinning in `while(true)` or blocked
in `Atomics.wait`. `System.exit(n)` becomes ordinary process exit (`onExit(n)`) instead of
killing a shared daemon. Startup cost is hidden by **pre-booting the next iframe** right
after a run ends (boot + javac warm-up happen before the user presses Run).
Alternatives rejected: persistent daemon (cannot stop without losing it anyway; leaks
state), Worker-hosted module (works in principle, but an iframe is the natural step to
Phase 5's separate origin and its teardown is the most reliable).
Costs to measure: ~256 MB shared memory per context; while a run is active and the next is
not yet pre-booted only one exists — the spare is created *after* the active one is
destroyed.

## ADR-3 — Channels: control and student input are physically separate (revised)

- **Host → Java control:** exactly one line, `JAVAEDIT_GO <main.Class>\n`, sent before any
  user input is forwarded. Sources travel through MEMFS (`/work/src/**`), not stdin. After
  the GO line every input byte belongs to the program, so user input can't be parsed as a
  command (host test: `student input cannot be parsed as a control command`).
- **Input transport = append-only MEMFS file `/work/stdin`**, not the upstream fd 0 ring.
  Measured: the prebuilt's fd 0 reports `available() == 0` forever. Waiting on it would
  mean blocking in the native ring read, exposed to the upstream futex lost-wakeup race,
  with no observable waiting state. MEMFS lives on the iframe's main thread and the JVM's
  file syscalls are proxied there, so appends are visible immediately. This also removes
  the 3 KB ring limit and the spinning writer. The driver's `System.in` polls
  `available()` on that file (10 ms sleeps), emits `stdin-wait`/`stdin-resume`, and
  flushes `System.out`/`System.err` before waiting so prompts are visible.
  The ring is still *enabled*, so a program that reads `FileDescriptor.in` directly
  blocks harmlessly in its pthread (Stop still works) instead of reaching Emscripten's
  default TTY, which would call `window.prompt()` on the iframe's main thread.
- **Java → host control:** JSON lines on the dedicated write-only device `/dev/jectl`
  (`ready, compiling, compiled{diagnostics}, running, stdin-wait, stdin-resume, exit,
  error, compiler-crash`). stdout/stderr carry only program output. Output printed before
  the run starts (JVM boot noise such as the `Finalizer` NPE) goes to the log, not the
  console.
- **EOF:** byte `0x04` is reserved; the engine strips control characters from user input
  (`sanitizeInput`), so `0x04` can only come from the EOF control.
- **Pitfall found:** opening a stream in `preRun` took fd 0, because `FS.init()` creates
  the standard streams after `preRun`. That shifted stdout to the stdin device. The append
  stream is now opened lazily.
- **Residual:** student code can reach `/dev/jectl`, `/work/stdin` or the driver via
  reflection or file APIs and spoof its *own* status events. The impact is limited to the
  student's own console. Documented, not mitigated.

## ADR-4 — Compilation

Single `JavaCompiler` task over all `*.java` under `/work/src`, in-memory output
(`ForwardingJavaFileManager`), options `-proc:none -implicit:none -g -encoding UTF-8`.
No `--release` (lets us drop the 10.7 MB `ct.sym`). Diagnostics carry the project-relative
path (from the `JavaFileObject`), line, column, severity; notes are dropped; a javac
exception is a distinct `compiler-crash` event. Student classes load through an unnamed
child loader whose parent is the **platform** loader, so the driver is not resolvable by
name. Stale bytecode cannot run: classes exist only in the JVM that compiled them.

## ADR-5 — Output

Per-byte stdout/stderr devices are merged into ordered chunks and flushed every 16 ms;
interleaving is preserved at byte granularity *as observed by the main thread* (JVM writes
are synchronous proxied syscalls, so order matches the program's write order). Cap: 1 MB
per run (configurable) → `output-limit` event, run is torn down.

## ADR-6 — Observing `System.exit` (new)

Measured: in the WASM JVM, `System.exit(n)` never reaches Emscripten `onExit`, so without
help the run hangs until the timeout. JDK 21's `Runtime.exit` logs
`"Runtime.exit() called with status: N"` to `System.Logger("java.lang.Runtime")` at DEBUG,
synchronously and before shutdown. The driver attaches a `java.util.logging` handler to
that logger (level FINE, no parent handlers) and emits `{"t":"exit","code":N}`. The engine
then destroys the iframe, whatever the JVM does next. Side effect: student code that
configures the `java.lang.Runtime` JUL logger could interfere, which only affects its own
run. On JDK 17 (host tests) the handler never fires and the process simply exits.

## Deviation log

| # | Plan | Deviation | Reason |
|---|---|---|---|
| D1 | Gate 0: run upstream demo + tests | The prebuilt runtime ran via our own slice/e2e. Upstream's Playwright suite was not run | At first blocked by the session permission policy; unblocked once the user ran the e2e command. Upstream's suite targets Doom and its own UI, which we don't ship. |
| D2 | Engine in TypeScript | Plain ES modules (`runtime/engine/*.js`) for the slice | Runs without a bundler while the runtime is unverified; port to TS with the Vite app in Phase 4. |
| D3 | Separate control/input channels | One-shot GO line on stdin + MEMFS sources + `/dev/jectl` | Achieves the separation without a native rebuild. |
| D5 | Use JavaBox's SAB/Atomics stdin bridge | MEMFS append-file input channel | Prebuilt `available()` on fd 0 is broken and the ring has a lost-wakeup race; the file channel is observable and race-free. A source build could restore the ring once those are fixed. |
| D6 | `System.exit` handled by the runtime | Observed through JDK 21 Runtime.exit logging | `onExit` never fires for `System.exit` in the prebuilt. |
| D4 | Fork of JavaBox | Pinned upstream submodule, driver replaced at runtime | No fork needed yet; native changes (futex fix, socket denial, Doom removal) would require one in Phase 3. |
