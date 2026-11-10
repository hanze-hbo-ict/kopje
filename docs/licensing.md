# Licensing (Phase 0 audit — not legal advice)

| Component | Licence | Shipped to users? | Obligations / plan |
|---|---|---|---|
| Kopje (this repo, <https://github.com/hanze-hbo-ict/kopje>) | to be decided by the owner | yes, incl. `runtime/native/*` linked into the `.wasm` and the NIO patch in the `.data` | public repo is the source offer for our own runtime parts: footer link "Kopje on GitHub" and, in `THIRD_PARTY_NOTICES.txt`, a link to the exact deployed commit (filled in at build; `verify:dist` requires it and rejects builds with uncommitted changes) |
| JavaBox (`vendor/javabox`) | MIT, © 2026 Brian Martin | glue `.mjs`, `jvm-main.c` (compiled into `.wasm`) | keep MIT notice in distributed `THIRD_PARTY_NOTICES` |
| OpenJDK 21u fork (`openjdk` submodule) | GPLv2 **with Classpath Exception** (+ Assembly Exception); per-module `legal/` notices | yes: HotSpot/libjava in `.wasm`, class library in `.data` | ship `/opt/jdk/legal/**` (already inside the image), offer corresponding source by linking to the exact pinned commits (OpenJDK fork `e339656c`, JavaBox `506756b`, libffi `0b72a27`) in `THIRD_PARTY_NOTICES.txt`. **Decision (2026-11-10):** source availability is left to the upstream repositories; no own mirror or source archive. Residual risk: if upstream removes them, the link no longer satisfies the source offer. Our own modifications that end up in the binaries (HotSpot linked with `jvm-main.c`; modified `sun.nio.fs` classes) are not upstream; their source is this repo at the deployed commit. |
| libffi (`third-party/libffi-emscripten`) | MIT-style (Anthony Green, Red Hat et al.) | yes, in `.wasm` | include notice |
| Emscripten runtime glue | MIT / University of Illinois NCSA | yes | include notice |
| Mocha Doom (`container/doom`) | GPL (Mocha Doom) | **no** — excluded from our build | prebuilt currently contains `doom.jar` → must not be redistributed by us; Phase 3 build drops it |
| Freedoom IWAD | BSD-3-Clause | **no** | excluded |
| xterm.js (upstream demo) | MIT | no (not used) | — |
| Klode (`hanze-hbo-ict/klode`) | MIT, © 2026 Codeklad contributors | yes: design tokens, styles and small UI patterns adapted in `src/styles.css`, `src/editor/editor-theme.ts`, `src/console/JavaConsole.ts`, `src/ui/theme.ts` | attribution in those files and in `THIRD_PARTY_NOTICES.txt` |

**Distribution plan:** do not deploy the upstream prebuilt as-is (it contains Doom). Deploy a
Phase 3 source-built runtime, publish its exact source revisions and build script, include
`THIRD_PARTY_NOTICES` plus `legal/` from the jlink image.
