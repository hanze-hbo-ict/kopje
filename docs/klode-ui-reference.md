# Klode UI reference (Phase 4.1)

Observed 2026-11-10 at <https://klode.app> (Playwright Chromium, 1440×900 and 390×844, light and
dark) and in its source, `hanze-hbo-ict/klode` @ `cfed3adb`. That source is **MIT-licensed**
(© 2026 Codeklad contributors), so tokens and small patterns are reused **with attribution**
(see `THIRD_PARTY_NOTICES.md`). Screenshots: `docs/klode/`.

## Observed

| Aspect | Klode |
|---|---|
| Stack | Vite 8, CodeMirror 6 (pinned), vanilla JS modules, Pyodide in a Worker |
| Layout | Header (brand mark "k.", name, tagline, theme toggle) → eyebrow "PYTHON WORKSPACE" → grid of two 12 px-radius panels: editor `1.3fr`, console `1fr`, height `clamp(320px, 100dvh − 265px, 760px)` → motto → footer |
| Panel header | 62 px; file name with a coloured dot on the left; action on the right |
| Type | Inter UI 16 px base; 13 px panel titles (600); mono `"Cascadia Code", SFMono-Regular, Consolas` 14 px editor / 13 px console, line-height 1.8 |
| Colour | Tokens on `:root` and `:root[data-theme=dark]` (bg `#f6f7f9`, panel `#fff`, ink `#202b3d`, muted `#6b7484`, line `#dfe4ec`, accent `#315ac6`, run green `#236b45`, stop red `#a63643`, plus six syntax colours) |
| Run control | One button, 110 px: "▶ Run code" (green) ⇄ "■ Stop" (red). Stop appears only after 300 ms of running, to avoid flicker; disabled "Loading…" during boot |
| Status | Right of the console header: dot + text — Loading Python… / Ready (green) / Running, Waiting for input (amber) / Unavailable (red) |
| Console | Transcript in one `<span role=textbox aria-readonly>`; output batched per animation frame; errors in a separate `<pre role=alert>` (red on pink) |
| stdin | Borderless `<input>` **inline after the prompt text**, auto-sized in `ch`, focused on request, Enter submits one line (empty allowed); the echoed answer is appended to the transcript; hidden otherwise |
| Theme | Three-way toggle System → Light → Dark (icon button with descriptive `aria-label`) |
| Editor | `indentWithTab`, 4-space indent, closeBrackets, bracketMatching, active line, line numbers, **no completion**; theme switch reconfigures a compartment (keeps undo) |
| Focus | 2 px focus border on the padded editor/console containers; `:focus-visible` outlines on buttons and links |
| Mobile (≤ 740 px) | Panels stack (editor above console), 16 px gutters, tagline hidden, smaller brand |
| Copy | "One file. One idea at a time." / "No code completion or AI assistance" |

## Retained as-is

Tokens (both themes), typography, panel/header geometry, Run⇄Stop button and colours, status dot
and labels, inline stdin interaction, per-frame output batching, theme toggle, editor
configuration (minus Python), focus treatment, mobile stacking breakpoint, footer statement.

## Adapted for Java

| Need | Adaptation |
|---|---|
| Multiple files and packages | Compact **file list inside the editor panel** (left column, ~190 px) with New / Rename / Delete. Paths are shown as typed (`example/Main.java`). On ≤ 740 px it becomes a horizontal, scrollable strip above the editor. The two-panel grid is kept. |
| Main class + arguments | A command line at the top of the console: `$ java [main class ▾] [arguments]`. The menu lists only classes that declare `public static void main(String[])`; the choice stays explicit. Run stays in the editor header; Enter in the arguments field also runs. The command is echoed above the output, like a terminal. |
| Compile step | Extra status "Compiling…"; **Stop is shown immediately** during compile and run, because javac takes over a second in the interpreter, so the 300 ms reveal would not prevent flicker anyway. |
| Compiler diagnostics | Shown as a list of buttons under the transcript (`file:line:col message`); activating one opens the file and places the cursor on that line. |
| stderr and exit status | stderr is shown inline in the transcript in the error colour (preserving interleaving). A non-zero exit, Stop, timeout or output limit adds one muted status line. |
| EOF | Ctrl+D in the input line sends end-of-input (described in the input's help text). |
| Session restore | Klode keeps nothing; we restore files and UI state from `sessionStorage` on reload of the same tab. |
| Branding | Klode's "k." mark (same icon, by choice) and the name "Kopje" (Dutch for "cup", a nod to Java's coffee; keeps the Java trademark out of the name), tagline "A little cup of Java.". The structure deliberately mirrors Klode, but the name is not used so it isn't mistaken for Klode itself. |
| Eyebrow / motto | "JAVA WORKSPACE" / "A few files. Still one idea at a time." (a riff on Klode's "One file. One idea at a time.") |
