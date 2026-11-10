# Architecture and decisions

```text
IDE page (static)                         runtime iframe (one per run, disposable)
┌──────────────────────────┐   postMessage  ┌───────────────────────────────────────────┐
│ JavaBoxEngine            │ ─────────────▶ │ runtime-host.js                           │
│  · validate paths/limits │ start/stdin/eof│  · preRun: write driver → /opt/Kopje,  │
│  · one run at a time     │ ◀───────────── │    mkdir /work/src, create /dev/jectl     │
│  · timeout, Stop         │    events      │  · stdout/stderr per-byte devices         │
│  · prewarm next iframe   │                │  · bounded writes into stdin ring         │
└──────────────────────────┘                │ JavaBox WASM (PROXY_TO_PTHREAD, 16 Workers)│
                                            │  └ JVM → Kopje CompileServer (driver)  │
                                            │       compile all files → run main → exit │
                                            └───────────────────────────────────────────┘
```

Code: `runtime/java/CompileServer.java` (driver), `runtime/host/` (iframe, plain JS, copied
unbundled into the content-versioned `public/runtime/<hash>/`), `src/runtime/` (`JavaEngine`, `JavaBoxEngine`, protocol types), `src/`
(IDE), `slice.html` (engine test page).

## ADR-1 — Replace the driver at runtime, not by relinking (revised after testing)

`jvm-main.c` hard-codes `FindClass("CompileServer")` with class path
`/opt/javabox:/opt/javabox/doom.jar`. The original plan was to pass
`-Djava.class.path=/opt/Kopje` via `Module.arguments`. **Testing showed the prebuilt
ignores `Module.arguments`**, so the runtime host instead:

1. calls `addRunDependency('kopje-driver')` in `preRun`, which holds back `main()`;
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

- **Host → Java control:** exactly one line, `KOPJE_GO <main.Class>\n`, sent before any
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
| D2 | Engine in TypeScript | ~~Plain JS for the slice~~ **resolved**: ported to `src/runtime/*.ts` in Phase 3/4 | — |
| D3 | Separate control/input channels | One-shot GO line on stdin + MEMFS sources + `/dev/jectl` | Achieves the separation without a native rebuild. |
| D5 | Use JavaBox's SAB/Atomics stdin bridge | MEMFS append-file input channel | Prebuilt `available()` on fd 0 is broken and the ring has a lost-wakeup race; the file channel is observable and race-free. A source build could restore the ring once those are fixed. |
| D6 | `System.exit` handled by the runtime | Observed through JDK 21 Runtime.exit logging | `onExit` never fires for `System.exit` in the prebuilt. |
| D7 | Trim modules in upstream `build-jdk-modules.sh` | Our own jlink step in `scripts/build-runtime-source.sh`; upstream scripts otherwise unchanged | Avoids forking JavaBox; also pins the jlink JDK to 21.0.10 to match HotSpot. |
| D8 | Build in the repo | Build in a space-free copy (`~/kopje-build`) | libtool/OpenJDK configure fail on the project path, which contains spaces. |
| D9 | Runtime iframe hosted on a separate origin | Opaque-origin sandbox on the same host (ADR-10); same-origin fallback on WebKit | No second origin to whitelist; WebKit can't isolate sandboxed frames. |
| D4 | Fork of JavaBox | Pinned upstream submodule, driver replaced at runtime | No fork needed yet; native changes (futex fix, socket denial, Doom removal) would require one in Phase 3. |

## ADR-7 — IDE structure (Phase 4)

Klode's two-panel layout, tokens and controls are kept (`docs/klode-ui-reference.md`).
Additions live *inside* those panels: a file column in the editor panel (a horizontal
strip at ≤ 740 px), a main-class `<select>` beside Run, and diagnostics and status notes
below the console transcript. One `EditorView` with one `EditorState` per file, so undo
history and selection survive switching files. `ProjectManager` owns the files and path
rules and emits changes; `SessionStore` persists `{files, mainClass, activeFile, theme}`:
edits are debounced (400 ms), file and UI operations save immediately, and it falls back
to memory on any storage error. File operations and the main-class picker are locked
while a program runs; editing is allowed, because each run works on a snapshot of the
files.

## ADR-8 — File I/O: recompile `sun.nio.fs` for Emscripten (F1)

JavaBox runs the **macOS** class library on natives compiled for Emscripten.
`sun.nio.fs.UnixConstants` is generated per target from C headers, and its values are
compile-time constants inlined into 14 `sun.nio.fs` classes. 37 of its 60 values differ
from Emscripten's: `O_CREAT` is 512 on macOS (`O_TRUNC` on Emscripten), and every errno
differs (Emscripten uses WASI numbering, e.g. `ENOENT` 44). As a result NIO opened files
with the wrong flags and misread errors. `scripts/build-nio-patch.sh` generates
`UnixConstants` from the pinned OpenJDK template with Emscripten's preprocessor (like
OpenJDK's `GensrcMisc`), recompiles the whole `sun.nio.fs` package of the same revision
against it, and makes the two `BsdFileSystem` copy paths that need unlinked macOS natives
(`clonefile`, `fcopyfile`) report "unsupported", so the portable buffered copy is used.
The patch ships at `/opt/jdk/patch/java.base` and is loaded with `--patch-module`.
A Linux JDK's classes were considered and rejected: errno values still differ, the
aarch64 `O_*` flags differ too, and Linux classes call other unlinked natives
(`LinuxNativeDispatcher`, `copy_file_range`, epoll; `FileDispatcherImpl.<clinit>`).

## ADR-9 — Loading and caching (E5)

`scripts/prepare-runtime.mjs` assembles the runtime iframe, driver classes and JavaBox files
into `public/runtime/<hash>/`, where `<hash>` covers every file. The path is generated into
`src/runtime/runtime-location.generated.ts` and bundled into the hashed app script, so only
`index.html` is revalidated (`no-cache`); `/assets/*` and `/runtime/*` are cached for a year
as `immutable`. The `.wasm` and `.data` ship **only** as `.gz` (the raw `.data` is ~33 MB, over
Cloudflare Pages' 25 MiB per-file limit), which the runtime host fetches and decompresses with
`DecompressionStream` (required; all current browsers have it), handing the results to Emscripten through
`instantiateWasm` and `getPreloadedPackage`; this makes transfer size independent of whether
the static host compresses binary types. The jimage is linked uncompressed (`zip-0`), which
gzips far better (10.3 MB vs 14.5 MB). Measured (Chromium, persistent profile): first load
12.0 MB, reload 0.8 KB.

## ADR-10 — Opaque-origin sandbox for the runtime (Phase 5, S4)

Each runtime iframe has `sandbox="allow-scripts"` (no `allow-same-origin`) and
`allow="cross-origin-isolated"`, so it gets an **opaque origin**: even code that escaped the
WASM sandbox could not read the IDE's DOM, `sessionStorage` or cookies. No second origin or
whitelist entry is needed.

- **No network in the sandbox.** The IDE page fetches the runtime files once (module source,
  `.wasm.gz`, `.data.gz`, driver classes) and posts a copy to each new frame, which asks for
  them with `awaiting-assets`. `/runtime/*` responses carry a second CSP,
  `connect-src 'none'`, enforced alongside the main one. (This also avoids a WebKit
  difference: it evaluates `'self'` in an opaque-origin frame as the opaque origin.)
- **Workers.** Opaque origins may not start Workers from http(s) URLs, and Chromium refuses
  *module* Workers from Blob URLs there. The module runs from a Blob URL
  (`mainScriptUrlOrBlob`), and the runtime host wraps `Worker` so Emscripten's pthreads start
  as **classic** Blob Workers that `import()` the module and replay early messages. CSP allows
  `blob:` for `script-src`/`worker-src`.
- **Headers.** `/runtime/*`: `Cross-Origin-Resource-Policy: cross-origin` (Firefox requires
  it for the frame document under COEP) and `Access-Control-Allow-Origin: *` (the frame's
  module script is a CORS request); these are public static files.
- **Messages.** The engine accepts messages only from its frame's window with origin `"null"`
  and posts with target `'*'` to that window. The frame posts to `parent` with `'*'`; only our
  pages can be its parent because of `frame-ancestors 'self'`.
- **WebKit fallback.** WebKit doesn't make opaque-origin frames cross-origin isolated, so the
  frame can't share WASM memory with its Workers (`DataCloneError`). The frame reports
  `isolated: false`; the engine then reloads it without `sandbox` (same-origin) for the rest of
  the session. In that mode the frame still fetches nothing and keeps `connect-src 'none'`.
  Verified: Chromium and Firefox sandboxed (Gate 5, `isolation.spec.mjs`), WebKit fallback.
