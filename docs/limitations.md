# Known limitations

Evidence for each item is in `docs/baseline.md`, `docs/capability-matrix.md` or the named test.

## Security and isolation

- **Not a verified sandbox.** Student code runs in a WebAssembly JVM inside an
  **opaque-origin sandboxed iframe** without network access (ADR-10). Isolation rests on
  (a) no Java→JavaScript bridge in the runtime's host imports, (b) no networking (libnet and
  sockets not linked, `connect-src 'none'`), (c) the opaque origin, and (d) per-run teardown.
  **Safari/WebKit** can't run the runtime in the sandbox (it doesn't isolate opaque-origin
  frames) and uses a same-origin frame instead, so (c) doesn't apply there.
- **No socket layer.** Java networking fails (`InetAddress.<clinit>`), socket syscalls return
  `EACCES` and SOCKFS is not linked (N1); the CSP `connect-src 'self'` is a second layer.
- **Headers are part of the security model.** The CSP, COOP/COEP and framing headers come
  from `security-headers.mjs`; a deployment must serve `dist/_headers` (or equivalent). A host
  that drops them breaks Java (no `SharedArrayBuffer`) and removes the CSP.
- **Control-event spoofing.** Student code can write to the driver's control device or input
  file via file APIs/reflection and fake its *own* status events (e.g. a fake "exit").
  Impact is limited to that student's console.
- **Timeouts are wall-clock** (2 minutes, excluding time waiting for input), not a CPU
  quota. Memory is bounded by the WASM maximum (512 MB) and `-Xmx128m`.

## Java compatibility

- **File I/O works on an ephemeral in-memory filesystem** (`java.io` and `java.nio.file`,
  `fileio.spec.mjs`). Files exist only during one run; the project's `.java` files are not
  visible to the program as files (they live in `/work/src`, but the working directory is
  `/root`). `Files.getFileStore` and `Files.probeContentType` throw `UnsatisfiedLinkError`
  (macOS-only natives). The class library is the macOS one with `sun.nio.fs` recompiled
  against Emscripten's constants (`scripts/build-nio-patch.sh`, ADR-8).
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
- **Recursion depth is limited to roughly 700 nested calls** in Edge/Chrome and Firefox
  (845 for trivial methods; a desktop JVM allows ~10,000). HotSpot Zero makes one native
  WASM call per Java call, and the browser's worker stack (~1 MB in Chromium) is the real
  limit. The program runs on a 320 KB thread so the JVM throws a normal, catchable
  `StackOverflowError` first. Safari's worker stack is smaller still; there the browser
  limit is reached first and the run ends with a "StackOverflowError: … deeper than the
  browser allows" message instead of hanging (`correctness.spec.mjs`).
- **Main method:** classic `public static void main(String[])` only (no JDK 21 preview
  instance-main). The main-class menu is filled by a source scanner, not by javac; unusual
  code (e.g. a `main` behind a Unicode escape) may be missed. Program arguments follow POSIX
  shell quoting (`\` escapes, `'…'`, `"…"`), because the field is shown as a `$` prompt. Shell
  features Kopje lacks (pipes, redirects, `;`, `&`, `$VAR`, `` `…` ``, `#` comments) are
  rejected with a message instead of passed on as text; globs, braces and `~` aren't
  expanded. At most 100 arguments / 1000 characters.
- **Rename is not a refactoring:** renaming `A.java` does not change `class A` or package
  declarations; javac reports the mismatch. The main-class menu shows the name declared in
  the source, so it keeps showing `A` until the class itself is renamed.

## Export, import and reset

- **Export / Import** use a plain-text bundle: each file is preceded by a line
  `// File: <path>`. Exporting a single file copies its source without a header. A source
  line that is exactly `// File: <path>` is read as a new file on import. Importing a single
  class without headers derives its path from `package` and the first top-level type.
- If the browser refuses the Clipboard API, the export preview is selected for Ctrl+C.
- **Reset** returns to the last full import (Import → Replace project), including files added
  since with Import → Add to project, or to the example project if nothing was imported. The
  import is kept in `sessionStorage` with the files.

## Storage and privacy

- Files and UI state live in **`sessionStorage`** of the tab. Browsers may restore it when a
  closed tab or a whole session is restored; a duplicated tab starts with a copy;
  `sessionStorage` is not a secure-deletion mechanism. Compiled classes and console
  output are never stored. If storage fails (quota, disabled), the IDE keeps working in
  memory and shows a warning in the footer. **New** resets to the template and removes the
  stored session. Closing or leaving the tab with a changed project shows the browser's
  "leave page?" warning (also on reload, which the browser can't tell apart).

## Browsers

- Requires cross-origin isolation (COOP `same-origin` + COEP `require-corp`) for
  `SharedArrayBuffer`. Verified headless: Chromium 158, Firefox 159, WebKit 27.2.
  Real Safari, iOS/Android browsers: not yet tested.
- The Vite **dev server** is very slow at serving the runtime (78 s instantiation observed);
  use the production build (`npm run build && npm run serve`) for anything but UI work.

## Distribution

- Needs `DecompressionStream` (Chrome/Edge 80+, Firefox 113+, Safari 16.4+): the runtime ships
  gzip-only. Older browsers get a clear error instead of Java.
- First load transfers ~12 MB (runtime `.gz` files, decompressed in the browser); later loads
  come from the HTTP cache (0.8 KB measured). The host must keep `/runtime/*` and
  `/assets/*` cacheable (`dist/_headers`). Each runtime holds the ~35 MB uncompressed class
  library in memory.
  Each runtime grows to ~232 MB of WASM memory (~410 MB browser RSS with one runtime). On
  devices reporting ≤ 4 GB (`navigator.deviceMemory`) or after a failed boot, no spare runtime
  is pre-booted, so each Run pays ~2 s of boot.
- Heap limit for student programs: 96 MB (`-Xmx96m`).
- The upstream **prebuilt** (`runtime-prebuilt/`) contains GPL Doom code and must not be
  deployed; deploy only a source build from `scripts/build-runtime-source.sh`.
