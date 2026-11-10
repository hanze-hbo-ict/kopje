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

- [ ] Working JavaBox fork with upstream commit pinned.
- [ ] Repeatable source build and local static server with required headers.
- [ ] Multi-file compiler and structured diagnostics.
- [ ] Interactive console (stdin, stdout, stderr) and reliable Stop.
- [ ] Trimmed JDK build and documented capability restrictions.
- [ ] Minimal IDE: CodeMirror, file operations, main-class selection, console.
- [ ] Klode-inspired UI with a documented visual/interaction reference and Java-specific adaptations.
- [ ] `sessionStorage` reload behavior with no intentional permanent storage.
- [ ] Automated browser and adversarial-behavior tests.
- [ ] Baseline versus trimmed-runtime benchmarks.
- [ ] `README.md` for development, build and deployment.
- [ ] `docs/architecture.md`, `docs/capability-matrix.md`, `docs/licensing.md` and `docs/limitations.md`.

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
