# Phase 0 — JavaBox baseline

**Status:** Gate 0 **partially met.** Static reconnaissance, licence audit and host-side
tests are done. **Running the JavaBox runtime has not been verified**: in the agent
session, executing the downloaded/upstream runtime code (prebuilt `.mjs`/`.wasm`, the
upstream `fetch-prebuilt.sh`, and therefore any upstream source build) was blocked by the
session's permission policy. Every number below marked *pending* needs that permission
(or a human run of `npm run test:e2e`).

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
Docker available. Browsers: *pending* (Playwright Chromium/Firefox/WebKit).

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
`new WebSocket(ws://host:port)`. Whether Java reaches it (`sun.nio.ch.Net.connect0`) or
first hits an aborting `NET_*` stub is *pending* a runtime test. Either way it is a
host-level egress path that must be closed (Phase 3: CSP `connect-src` + override
socket syscalls in the glue).

**Filesystem.** Emscripten MEMFS only, populated from the preload package (`/opt/jdk`,
`/opt/javabox`). Ephemeral, per module instance. Writable by student code.

**Termination.** No API to stop a run. `proc_exit` calls
`PThread.terminateAllThreads()` and `onExit`. Workers belong to the creating document,
so removing that document (iframe) is the teardown strategy (ADR-2).

**Persistent storage.** None found in the runtime. Upstream page uses none.

**Browser support (upstream claim).** Chrome 92+, Firefox 79+, Safari 15.2+ (SAB).
*Pending* own verification.

## Metrics

| Metric | Value |
|---|---|
| Total download (prebuilt, uncompressed / brotli) | 79.0 MB / 48.0 MB |
| Cold boot to JVM ready | *pending* (upstream claims 3–5 s) |
| Boot incl. javac warm-up (driver `ready`) | *pending* |
| Warm compile+run (Hello World, 2 files) | *pending* (upstream claims < 1 s) |
| WASM memory after run | *pending* (initial 256 MB) |
| Stop latency (iframe removal) | *pending* |

Host-JVM reference (not WASM): driver compile+run of the 2-file fixture ≈ 250 ms
wall-clock per fresh `java` process including JVM start (Node test runner timings).

## Tests

| Suite | Command | Result (2026-11-10) |
|---|---|---|
| Upstream Playwright | `npx playwright test` in `vendor/javabox` | **not run** — executes upstream runtime (blocked) |
| javaedit unit (paths) | `npm run test:unit` | 6/6 pass |
| javaedit driver on host JDK 17 | `npm run test:host` | 14/14 pass |
| javaedit e2e (Gate 2 slice) | `npm run build:runtime && npm run test:e2e` | **written, not run** (blocked) |

Upstream source build: not attempted (would run upstream build scripts; also blocked).
Prerequisites present: emcc 5.0.2 (upstream tested with 5.0.2), Docker. Missing: JDK 21
(`brew install openjdk@21`), GNU grep/autotools not checked.
