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
| Outbound TCP (`java.net.Socket`) | **denied** (unsupported) | (1) libnet not linked → `UnsatisfiedLinkError: InetAddress.init()`; (2) CSP `connect-src 'self'` blocks any WebSocket/fetch egress from the page and runtime | probe `socket`; `security.spec.mjs` (fetch to another origin blocked). SOCKFS is still linked until N1 removes it |
| `HttpURLConnection` | **denied** | `ExceptionInInitializerError` in `NioSocketImpl.<clinit>` | probe `http` |
| DNS | **denied** | same as TCP | probe `dns` |
| Read host/real filesystem (`/etc/passwd`) | **unsupported** | only MEMFS exists (`/tmp /home /dev /proc /root /work /opt`) | probe `fileOutside` |
| Read runtime files (`/opt/jdk/**` via `..`) | allowed | per-run MEMFS, destroyed with the iframe | probe `fileTraversal`; harmless, no user data in MEMFS |
| Write files (NIO `Files.writeString` to `/tmp`) | **fails (compat gap)** | upstream MEMFS/NIO issue | probe `fileWrite`; file exercises will need a fix or `java.io` (unverified) |
| `ProcessBuilder` / `Runtime.exec` | **denied** | `posix_spawn` → ENOSYS | probes `process`, `exec` |
| `System.loadLibrary` / `System.load` | **denied** | no dynamic loader; static symbol table only | probes `loadLibrary`, `load` |
| IDE `sessionStorage` from student code | unsupported (no Java→JS bridge) | same-origin iframe; no eval-like import | static import audit. Phase 5: separate origin |
| IndexedDB / localStorage / OPFS from runtime | unsupported | not linked | static grep of glue |
| `System.exit` | allowed: ends the run only | ADR-6 + iframe teardown | slice spec: exit code 3 then clean run |
| CPU time | bounded by wall clock (120 s, excluding stdin wait) | engine timer + teardown | not a CPU quota |
| Memory | bounded: 512 MB WASM max, `-Xmx128m` | link flag, JVM | high-water mark not measured |
| Threads in student code | unverified / out of scope | pool of 16 pthreads | — |
| Doom graphics/audio/input natives | **present in the `.wasm`** (from `jvm-main.c`), unreachable: no Doom classes and no `java.desktop` in the trimmed image | removing them needs a JavaBox fork | — |
| Spoofing driver control events | **allowed (residual)** | — | affects own console only |
| Code/classes/JVM options chosen by URL parameters | **denied** | runtime host uses fixed same-origin paths; only `outputCap` (clamped) is read | `security.spec.mjs` S1 |
| Framing by other sites | **denied** | CSP `frame-ancestors 'self'`, `X-Frame-Options: SAMEORIGIN` | `security.spec.mjs` S2/S7 |
| Inline/foreign scripts and styles | **denied** | CSP `script-src 'self' 'wasm-unsafe-eval'`, `style-src 'self'`; editor in a shadow root uses constructed stylesheets | `security.spec.mjs` (no CSP violations during a full run) |
