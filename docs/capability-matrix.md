# Capability matrix (initial — Phase 0 static analysis)

Status values: **allowed / denied / unsupported / unverified**. Nothing below has been
verified against the running WASM runtime yet (see baseline.md, D1). This runtime is a
best-effort, capability-restricted environment, **not** a verified sandbox.

| Capability | Status | Enforcement layer | Evidence / test |
|---|---|---|---|
| stdout / stderr | allowed | driver + per-byte devices, 1 MB cap | host: `driver.test.mjs`; e2e: `slice.spec.mjs` (pending) |
| stdin | allowed | ring buffer, bounded host writes | host tests pass; e2e pending |
| Outbound TCP (`java.net.Socket`) | **unverified — likely egress** | none yet. SOCKFS maps `connect()` to `new WebSocket(ws://host:port)`; libnet `NET_*` are aborting stubs | static: `.mjs` contains `___syscall_connect` → SOCKFS → `WebSocketConstructor`. Phase 3: CSP `connect-src 'self'` + override socket syscalls to return `-EACCES` |
| `HttpURLConnection` / `java.net.http` | unverified | same as above | Phase 3 test |
| DNS (`InetAddress.getByName`) | unverified | Emscripten fake DNS (no network) | Phase 3 test |
| File read/write in MEMFS | allowed (ephemeral) | MEMFS per iframe, destroyed per run | `/opt/jdk` is writable by student code — harmless (per-run) but noted |
| Access to user's real filesystem | unsupported | no NODEFS/WORKERFS mounts in browser build | static: no mount in glue |
| IDE `sessionStorage` from student code | unsupported (same-origin iframe, but no JS bridge from Java) | no Java→JS eval import | static import audit; Phase 5: distinct origin |
| IndexedDB / localStorage / OPFS from runtime | unsupported | not linked (no IDBFS/OPFS) | static grep of glue |
| `ProcessBuilder` / `Runtime.exec` | unverified (expected to fail: no fork/exec syscalls imported) | absence of syscalls | Phase 3 test |
| `System.load` / `loadLibrary` arbitrary | unverified (no dynamic loader; static symbol table only) | static linking | Phase 3 test |
| `System.exit` | allowed — ends the run only | disposable iframe | host test; e2e pending |
| CPU time | bounded by wall-clock timeout (120 s, excl. stdin wait) | engine timer + iframe teardown | not a CPU quota |
| Memory | bounded: 512 MB WASM max, `-Xmx128m` | Emscripten `MAXIMUM_MEMORY`, JVM | pending |
| Threads in student code | unverified / out of scope | Emscripten pool of 16 | — |
| Graphics/audio/input natives (Doom) | allowed in prebuilt (`jvm_doom_*`, `nativeRenderFrame`) | none — present in binary | remove in Phase 3 source build |
| Spoofing driver control events | **allowed (residual)** | — | student can reach `/dev/jectl`; affects own console only |
