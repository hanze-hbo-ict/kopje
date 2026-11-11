# Capability matrix (verified 2026-11-10)

Status values: **allowed / denied / unsupported / unverified**. Probes:
`tests/e2e/capabilities.spec.mjs`; lifecycle: `tests/e2e/slice.spec.mjs` and
`tests/e2e/ide.spec.mjs`. Results are identical for the upstream prebuilt and for our trimmed
source build (`java.base, java.logging, jdk.compiler`), which is what we ship. This is a best-effort, capability-restricted environment,
**not** a verified sandbox.

| Capability | Status | Enforcement layer | Evidence |
|---|---|---|---|
| stdout / stderr | allowed | per-byte devices, boot noise filtered, 1 MB cap → run torn down | slice spec: output-limit test |
| stdin | allowed | MEMFS append file, driver polling | slice spec: sequential reads |
| Outbound TCP (`java.net.Socket`) | **denied** (unsupported) | (1) libnet not linked → `UnsatisfiedLinkError: InetAddress.init()`; (2) CSP `connect-src 'self'` blocks any WebSocket/fetch egress from the page and runtime | probe `socket`; `security.spec.mjs` (fetch to another origin blocked). (3) N1: socket syscalls return `EACCES` and SOCKFS/WebSocket is not linked (build check in `build-runtime-source.sh`) |
| `HttpURLConnection` | **denied** | `ExceptionInInitializerError` in `NioSocketImpl.<clinit>` | probe `http` |
| DNS | **denied** | same as TCP | probe `dns` |
| Read host/real filesystem (`/etc/passwd`) | **unsupported** | only MEMFS exists (`/tmp /home /dev /proc /root /work /opt`) | probe `fileOutside` |
| Read runtime files (`/opt/jdk/**` via `..`) | allowed | per-run MEMFS, destroyed with the iframe | probe `fileTraversal`; harmless, no user data in MEMFS |
| Read/write files in MEMFS (`java.io`, `java.nio.file`) | **allowed** (ephemeral per run) | MEMFS in the runtime iframe; `sun.nio.fs` patched for Emscripten constants (F1); working directory `/root` (process cwd and `user.dir`) holds the project's data files (F2); new and changed files are listed to the student after the run, read-only (F3) | `fileio.spec.mjs`, `datafiles.spec.mjs`, `outputfiles.spec.mjs` (create, append, read, list, walk, copy, move, delete, attributes, temp files, Unicode names, correct exception types) |
| `Files.getFileStore`, `Files.probeContentType` | **unsupported** | call macOS-only natives that are not linked → `UnsatisfiedLinkError` | — |
| `ProcessBuilder` / `Runtime.exec` | **denied** | `posix_spawn` → ENOSYS | probes `process`, `exec` |
| `System.loadLibrary` / `System.load` | **denied** | no dynamic loader; static symbol table only | probes `loadLibrary`, `load` |
| IDE DOM, `sessionStorage`, cookies from the runtime | **denied** (Chromium/Edge, Firefox); unsupported (WebKit: no Java→JS bridge, same-origin fallback) | opaque-origin sandboxed iframe (ADR-10) | `isolation.spec.mjs` Gate 5 |
| Network from the runtime frame | **denied** | second CSP `connect-src 'none'` on `/runtime/*`; files come from the parent | `security.spec.mjs` S1/S4 |
| IndexedDB / localStorage / OPFS from runtime | unsupported | not linked | static grep of glue |
| `System.exit` | allowed: ends the run only | ADR-6 + iframe teardown | slice spec: exit code 3 then clean run |
| CPU time | bounded by wall clock (120 s, excluding stdin wait) | engine timer + teardown | not a CPU quota |
| Memory | bounded: 512 MB WASM max, `-Xmx96m`, code cache 8 MB, metaspace 64 MB | link flags, `jvm-main.c` | `memory.spec.mjs`: ~232 MB heap per runtime; `OutOfMemoryError` is a normal program error |
| Threads in student code | unverified / out of scope | pool of 16 pthreads | — |
| Doom graphics/audio/input natives | **removed** | own `runtime/native/jvm-main.c` (N1); build fails if Doom/audio symbols are present | `build-runtime-source.sh` checks |
| Spoofing driver control events | **allowed (residual)** | — | affects own console only |
| Code/classes/JVM options chosen by URL parameters | **denied** | runtime host uses fixed same-origin paths; only `outputCap` (clamped) is read | `security.spec.mjs` S1 |
| Framing by other sites | **denied** | CSP `frame-ancestors 'self'`, `X-Frame-Options: SAMEORIGIN` | `security.spec.mjs` S2/S7 |
| Inline/foreign scripts and styles | **denied** | CSP `script-src 'self' 'wasm-unsafe-eval'`, `style-src 'self'`; editor in a shadow root uses constructed stylesheets | `security.spec.mjs` (no CSP violations during a full run) |
