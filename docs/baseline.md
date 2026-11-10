# Phase 0 — JavaBox baseline

**Status:** Gate 0 **met for the prebuilt runtime** (2026-11-10). Static reconnaissance,
licence audit, host-side tests, and end-to-end runs in Chromium, Firefox and WebKit are done.
A reproducible **source build** exists (`docs/runtime-build.md`) and is what we ship.
Open: upstream's own Playwright suite was not run (it targets Doom/upstream UI, which we do
not use).

## Upstream pin

| Component | Revision |
|---|---|
| `bmarti44/javabox` (`vendor/javabox`, git submodule) | `506756b78cacedc23026fb4445e4cb57e11048b1` |
| `openjdk` submodule (branch `wasm-emscripten`) | `e339656cdd1c9e09aaf1c4ca9a87c399e3df56a7` |
| `third-party/libffi-emscripten` (branch `wasm-emscripten`) | `0b72a27b7cd647eb31f15144dcfeacde864de9f1` |

Prebuilt artifacts fetched on 2026-11-10 from `https://javabox-demo.brian-fec.workers.dev`
with plain `curl` into `runtime-prebuilt/` (git-ignored):

| File | Bytes | gzip -9 | brotli -9 | sha256 |
|---|---:|---:|---:|---|
| `javabox-direct.mjs` | 155 210 | 37 809 | 35 419 | `f8043bfd…ba4b7c` |
| `javabox-direct.wasm` | 3 272 146 | 1 131 086 | 930 304 | `a6adde60…5c9236` |
| `javabox-direct.data` | 75 595 652 | 50 732 074 | 47 072 097 | `837c057b…efd20` |

**Caveat:** the prebuilt is *not* proven to correspond to the pinned source revision. Any
change to the class library or native host bindings requires a source build (Phase 3).

### What is inside `javabox-direct.data` (75.6 MB)

| Content | MB | Needed? |
|---|---:|---|
| `/opt/jdk/lib/modules` (jimage, 33 modules, zip-6 compressed) | 32.8 | yes, will be trimmed (Phase 3) |
| `/opt/javabox/freedoom1.wad` | 28.8 | **no** — Doom |
| `/opt/jdk/lib/ct.sym` | 10.7 | no — only for `javac --release N`; the driver never passes `--release` |
| `/opt/javabox/doom.jar` | 1.3 | **no** — Doom |
| rest (conf, legal, tzdb, placeholder `.so`, `CompileServer*.class`) | ~2 | mostly |

Doom + `ct.sym` = **40.8 MB (54 %)** of the download that the IDE does not need. The
`.data` barely compresses (jimage is already compressed), so removing content is the only
real size lever. The JDK image was jlinked on **macOS** (it contains `shaders.metallib`,
`jspawnhelper`); upstream documents this as intentional (`build-jdk-modules.sh`).

## Test environment

Apple M1 Pro, 16 GB RAM, macOS 27.0; Node 25.8.1; host JDK 17.0.1 (Oracle); emcc 5.0.2-git;
Docker available. Browsers: Playwright Chromium headless shell 158, Firefox 159, WebKit 27.2 (headless).

## Runtime interfaces (from source + prebuilt glue)

**Topology.** `-sPROXY_TO_PTHREAD -sPTHREAD_POOL_SIZE=16`: `main()` (JVM) runs on a
pthread Worker; the page that calls `createModule` is the Emscripten "main thread" and
services proxied syscalls (FS, sockets, exit). 16 Workers are pre-spawned at startup.
`SHARED_MEMORY`, 256 MB initial / 512 MB max memory, `-Xmx128m -Xss512k -Xint
-XX:+UseSerialGC -Xshare:off`. Requires `crossOriginIsolated` (COOP/COEP).

**Compilation model (upstream).** `build/CompileServer.java` is a persistent daemon:
`JBOX_COMPILE <Class>\n<source>\nJBOX_END\n` over **stdin**, output and `JBOX_EXIT:<n>`
over **stdout**. One source per request; student code runs **in the daemon's JVM** via
reflection. Consequences: student `System.in` reads the same stream as the protocol
(student input and commands are ambiguous, and a program reading stdin can swallow the
next command), `System.exit` kills the daemon, static state/threads leak between runs,
and there is no Stop besides killing the module.

**Entry point.** `build/jvm-main.c` hard-codes `FindClass("CompileServer")` with
`-Djava.class.path=/opt/javabox:/opt/javabox/doom.jar`, and appends `Module.arguments`
as extra JVM options **after** the defaults. This lets us replace the driver without a
relink (see architecture.md, ADR-1).

**stdin.** A 4 KB static buffer (3 KB ring) in `jvm-main.c`; `jvm_stdin_write(ptr,len)`
(exported) writes and futex-wakes; `handleRead`/`handleAvailable` in the OpenJDK fork
(`io_util_md.c`, `__EMSCRIPTEN__` branch) read 1 byte per call / report occupancy for
fd 0 once `jvm_enable_ring_buffer_stdin()` was called. No EOF representation exists.
Findings:
- **Lost wakeup race:** the reader checks `rp != wp`, then `futex_wait(signal, 0)`; the
  writer sets `signal=1`, wakes, and resets `signal=0`. A write landing between the
  check and the wait leaves the reader asleep with data in the ring. Worked around in
  our driver by polling `available()` (no futex wait), see ADR-3.
- **Writer spins when full:** `jvm_stdin_write` sleeps-and-retries on the caller's
  thread; called from the page, that would freeze it. Our host never writes more than the
  free space (read via `jvm_debug_stdin_state()`).
- `setup_stdin_hook` / `create_fs_dirs` are `EM_JS` called from `main()` — i.e. on the
  pthread, not the main thread as the comments assume. They are effectively no-ops for
  the main-thread FS; we create `/tmp`, `/root` ourselves in `preRun`.

**stdout/stderr.** The glue honours `Module.stdout`/`Module.stderr` as **per-byte**
devices (`FS.createDevice`), so prompts without newline can be streamed and both streams
stay distinct. Upstream used line-based `print`/`printErr` instead.

**Host imports (99, from the `.mjs` `wasmImports` table).** WASI fd/clock/environ,
~45 `__syscall_*` (FS + **sockets**: `socket, connect, bind, listen, accept4, sendto,
recvfrom, sendmsg, recvmsg, getsockopt…`), mmap/munmap, pthread plumbing, `_exit`/
`proc_exit`, `ffi_call_js` (libffi: calls WASM table functions only), `setup_stdin_hook`,
`create_fs_dirs`, and auto-generated **aborting stubs** for libnet (`_NET_Bind`,
`_NET_SockaddrToInetAddress`, …, `_initInetAddressIDs`). No storage backends (no IDBFS,
NODEFS in browser, OPFS, localStorage). No generic JS-eval bridge found.

**Networking.** Emscripten **SOCKFS is linked**; its `connect()` creates
`new WebSocket(ws://host:port)`. **Verified:** Java never reaches it, because
`InetAddress.<clinit>` fails with `UnsatisfiedLinkError` (libnet is not linked), and Socket,
HTTP and DNS all fail without a WebSocket being opened. The SOCKFS path still exists in the
glue, so Phase 3 adds CSP `connect-src` and syscall overrides as a second layer.

**Filesystem.** Emscripten MEMFS only, populated from the preload package (`/opt/jdk`,
`/opt/javabox`). Ephemeral, per module instance. Writable by student code.

**Termination.** No API to stop a run. `proc_exit` calls
`PThread.terminateAllThreads()` and `onExit`. Workers belong to the creating document,
so removing that document (iframe) is the teardown strategy (ADR-2). **Verified** for
`while(true)` and a blocked `Scanner.nextLine()` in all three engines.

**Persistent storage.** None found in the runtime. Upstream page uses none.

**Browser support.** Upstream claims Chrome 92+, Firefox 79+, Safari 15.2+ (SAB).
Verified headless: Chromium 158, Firefox 159, WebKit 27.2. Real Safari and mobile are not
tested yet.

## Prebuilt vs. pinned source — verified differences

The deployed prebuilt is **older than the pinned source** in two ways that matter:

1. `Module.arguments` are **ignored** (`-version`, `-Djava.class.path=/nonexistent` had no
   effect), so the argv loop in today's `jvm-main.c` is not in the prebuilt.
2. `FileInputStream.available()` on fd 0 **always returns 0** while `read()` works
   (`tests/e2e/stdin-diag.spec.mjs`), so the `handleAvailable` emscripten branch is missing.

Also observed: the JVM's `Finalizer` and `Common-Cleaner` threads die with
`NullPointerException` at every boot (upstream filters these by text); `System.exit` does
**not** reach Emscripten `onExit`.

## Metrics (headless, Apple M1 Pro)

**Shipped runtime** = source build, modules `java.base, java.logging, jdk.compiler`, jlinked
with JDK 21.0.10, no Doom, no `ct.sym` (`docs/runtime-build.md`).

| Metric | Chromium 158 | Firefox 159 | WebKit 27.2 |
|---|---:|---:|---:|
| Cold boot → driver `ready` (module + JVM + javac warm-up) | 2.0 s | 2.2 s | 2.1 s |
| Run → first prompt, 2 files (spare still booting) | 1.9 s | 1.9 s | 1.9 s |
| **Compile+run, prewarmed spare** (Hello World; `soak.spec.mjs`) | 0.36–0.46 s | 0.30–0.32 s | 0.35–0.45 s |
| Back-to-back compile+run (no time for the spare to boot) | 2.1 s | 2.5 s | 2.3 s |
| Stop latency | 10–130 ms | 14–16 ms | 11–15 ms |
| Growth over 12 runs in one page | +30 % | +8 % | +30 % |

Upstream prebuilt for comparison: boot 1.8 / 2.5 / 2.1 s; identical behaviour.

The JVM itself starts in about 0.2 s. The javac warm-up compile (inside the boot) is the
dominant cold cost; after it, compiling a small project takes a few hundred ms. Because
the next runtime is pre-booted after each run, a student who reads the output before
pressing Run again gets the ~0.3–0.45 s path.

**Unexplained observation:** in one 27-minute full-suite run (all specs, all browsers,
sequentially) the Firefox and WebKit slice measured 10× slower (boot 19–24 s, compile+run
32–58 s); all tests still passed. Isolated reruns and the 12-run soak test do not
reproduce it. At the time the host was heavily loaded (load average ~120; `fileproviderd`
and Spotlight busy, as the project lives in a synced `~/Documents`), but the load was still
high during the fast reruns, so the cause is **not established**.

Sizes:

| | `.wasm` | `.data` | brotli total (approx.) |
|---|---:|---:|---:|
| Upstream prebuilt | 3.27 MB | 75.6 MB | 48.0 MB |
| Shipped source build | 3.20 MB | 15.6 MB | not measured |

Memory: 256 MB initial / 512 MB max shared WASM memory per runtime context (link flags); at
most two contexts exist (active + spare). JS heap / RSS high-water mark: not measured.

## Tests

| Suite | Command | Result (2026-11-10) |
|---|---|---|
| Upstream Playwright | `npx playwright test` in `vendor/javabox` | not run — tests Doom/upstream UI we do not ship |
| javaedit unit (paths, project, session storage) | `npm run test:unit` | 13/13 pass |
| javaedit driver on host JDK 17 | `npm run test:host` | 14/14 pass |
| Gate 2 slice | `npx playwright test slice` | 2/2 pass in Chromium, Firefox, WebKit (prebuilt and shipped runtime) |
| Gate 4 IDE | `npx playwright test ide` | 2/2 pass in Chromium, Firefox, WebKit |
| Capability probes | `npx playwright test capabilities` | 10/10 pass in all three (see capability-matrix.md) |
| Soak (12 runs/page) | `npx playwright test soak` | pass in all three |
| Full e2e, shipped runtime | `npm run build && npm run test:e2e` | 42/42 passed (27.5 min, see observation above) |

Upstream source build: **done** (2026-11-10, 3 min 41 s first build on the M1 Pro), see `docs/runtime-build.md`.

**Harness note:** port 5173 on this machine was already taken by an unrelated Vite app,
and `reuseExistingServer` silently tested *that* app. The dev server now uses port 5391
with `reuseExistingServer: false`.
