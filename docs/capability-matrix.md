# Capability matrix (prebuilt runtime, verified 2026-11-10)

Status values: **allowed / denied / unsupported / unverified**. Probes:
`tests/e2e/capabilities.spec.mjs` (Chromium); lifecycle: `tests/e2e/slice.spec.mjs`
(Chromium, Firefox, WebKit). This is a best-effort, capability-restricted environment,
**not** a verified sandbox.

| Capability | Status | Enforcement layer | Evidence |
|---|---|---|---|
| stdout / stderr | allowed | per-byte devices, boot noise filtered, 1 MB cap → run torn down | slice spec: output-limit test |
| stdin | allowed | MEMFS append file, driver polling | slice spec: sequential reads |
| Outbound TCP (`java.net.Socket`) | **denied** (unsupported) | libnet not linked → `UnsatisfiedLinkError: InetAddress.init()`; no WebSocket opened | probe `socket`. SOCKFS→WebSocket path **still present in glue**; Phase 3 adds CSP `connect-src 'self'` and socket syscall overrides |
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
| Doom graphics/audio/input natives | present in binary, unreachable (Doom classes removed from MEMFS) | removal pending source build | — |
| Spoofing driver control events | **allowed (residual)** | — | affects own console only |
