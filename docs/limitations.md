# Known limitations

Evidence for each item is in `docs/baseline.md`, `docs/capability-matrix.md` or the named test.

## Security and isolation

- **Not a verified sandbox.** Student code runs in a WebAssembly JVM inside a **same-origin**
  iframe. Isolation rests on (a) no Java→JavaScript bridge in the runtime's host imports,
  (b) libnet not being linked, and (c) per-run teardown. A same-origin iframe is a
  termination boundary, **not** a security-origin boundary (Phase 5: separate origin).
- **SOCKFS is still linked.** Java can't reach it (`InetAddress.<clinit>` fails), and the CSP
  `connect-src 'self'` blocks WebSocket egress at the browser. Removing SOCKFS at link time
  is planned (PLAN.md N1).
- **Headers are part of the security model.** The CSP, COOP/COEP and framing headers come
  from `security-headers.mjs`; a deployment must serve `dist/_headers` (or equivalent). A host
  that drops them breaks Java (no `SharedArrayBuffer`) and removes the CSP.
- **Control-event spoofing.** Student code can write to the driver's control device or input
  file via file APIs/reflection and fake its *own* status events (e.g. a fake "exit").
  Impact is limited to that student's console.
- **Timeouts are wall-clock** (2 minutes, excluding time waiting for input), not a CPU
  quota. Memory is bounded by the WASM maximum (512 MB) and `-Xmx128m`.

## Java compatibility

- **NIO file writes fail** (`Files.writeString("/tmp/x.txt")` → `FileSystemException: No
  such file or directory`) — an upstream MEMFS/NIO issue; `java.io` file APIs are
  unverified. File-I/O assignments are not supported yet.
- **Minimal class library:** `java.base`, `java.logging`, `jdk.compiler` (+ `java.compiler`,
  `jdk.internal.opt`, `jdk.zipfs`). No `java.sql`, `java.desktop` (AWT/Swing),
  `java.net.http`, `java.xml`. Add modules only after a compatibility test needs them.
- **Threads:** out of scope; Emscripten's pthread pool (16) is shared with JVM internals.
  The JVM's own `Finalizer`/`Common-Cleaner` threads die at boot with an NPE (upstream
  behaviour), so finalizers/cleaners don't run.
- **No network, processes or native libraries** (by design; see capability matrix).
- **`System.exit` code** is observed through JDK 21's `Runtime.exit` logging (ADR-6); a
  program that reconfigures the `java.lang.Runtime` JUL logger can hide its exit code
  (the run then ends via the timeout or Stop).
- **Speed:** Zero interpreter, no JIT. The javac warm-up adds ~1.5 s to each runtime boot (hidden by pre-booting); a warm compile+run of a small program takes 0.3–0.45 s;
  compute-heavy programs are slow.
- **Main method:** classic `public static void main(String[])` only (no JDK 21 preview
  instance-main).
- **Rename is not a refactoring:** renaming `A.java` does not change `class A` or package
  declarations; javac reports the mismatch.

## Storage and privacy

- Files and UI state live in **`sessionStorage`** of the tab. Browsers may restore it when a
  closed tab or a whole session is restored; a duplicated tab starts with a copy;
  `sessionStorage` is not a secure-deletion mechanism. Compiled classes and console
  output are never stored. If storage fails (quota, disabled), the IDE keeps working in
  memory and shows a warning in the footer.

## Browsers

- Requires cross-origin isolation (COOP `same-origin` + COEP `require-corp`) for
  `SharedArrayBuffer`. Verified headless: Chromium 158, Firefox 159, WebKit 27.2.
  Real Safari, iOS/Android browsers: not yet tested.
- The Vite **dev server** is very slow at serving the runtime (78 s instantiation observed);
  use the production build (`npm run build && npm run serve`) for anything but UI work.

## Distribution

- The runtime is ~19 MB per first load (`.wasm` 3.2 MB + `.data` 15.6 MB; brotli smaller),
  and each run instantiates a fresh 256 MB-initial WASM memory.
- The upstream **prebuilt** (`runtime-prebuilt/`) contains GPL Doom code and must not be
  deployed; deploy only a source build from `scripts/build-runtime-source.sh`.
