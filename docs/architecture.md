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

## ADR-1 — Replace the driver at runtime, not by relinking

`jvm-main.c` appends `Module.arguments` after its own JVM options and hard-codes
`FindClass("CompileServer")`. We write our driver classes into MEMFS in `preRun`
(`/opt/javaedit`, a directory the preload package does not touch, so ordering vs. the
package's own `preRun` does not matter) and pass `-Djava.class.path=/opt/javaedit`.
HotSpot takes the last `-Djava.class.path`. **Consequence:** our driver is named
`CompileServer` (default package). The upstream daemon and `doom.jar` are no longer on
the class path. No native rebuild is needed for Phases 1–2.
*Verification pending* (needs runtime execution).

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

## ADR-3 — Channels: control vs. student input are physically separate

- **Host → Java control:** exactly one line, `JAVAEDIT_GO <main.Class>\n`, sent before any
  user input is forwarded. Sources travel through MEMFS (`/work/src/**`), not stdin. After
  the GO line every stdin byte belongs to the program, so "user input parsed as a command"
  is impossible by construction (host test: `student input cannot be parsed as a control
  command`).
- **Java → host control:** JSON lines on a dedicated write-only device `/dev/jectl`
  (`ready, compiling, compiled{diagnostics}, running, stdin-wait, stdin-resume, exit,
  error, compiler-crash`). stdout/stderr carry only program output.
- **EOF:** the ring buffer has no EOF. Byte `0x04` is reserved; the engine strips control
  characters from user input (`sanitizeInput`), so `0x04` can only come from the EOF
  button.
- **stdin polling:** student `System.in` is a driver `InputStream` that polls
  `available()` (10 ms sleeps) and only then reads. This sidesteps the upstream futex
  lost-wakeup race and gives a reliable `waiting-for-input` event, and flushes
  `System.out`/`System.err` before blocking so prompts are visible.
- **Residual:** student code can reach `/dev/jectl` or the driver via reflection and spoof
  its *own* status events. Impact is limited to the student's own console. Documented,
  not mitigated.

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

## Deviation log

| # | Plan | Deviation | Reason |
|---|---|---|---|
| D1 | Gate 0: run upstream demo + tests | Not run | Executing upstream/prebuilt runtime code was blocked by the session's permission policy. Static analysis done instead; e2e spec prepared. |
| D2 | Engine in TypeScript | Plain ES modules (`runtime/engine/*.js`) for the slice | Runs without a bundler while the runtime is unverified; port to TS with the Vite app in Phase 4. |
| D3 | Separate control/input channels | One-shot GO line on stdin + MEMFS sources + `/dev/jectl` | Achieves the separation without a native rebuild. |
| D4 | Fork of JavaBox | Pinned upstream submodule, driver replaced at runtime | No fork needed yet; native changes (futex fix, socket denial, Doom removal) would require one in Phase 3. |
