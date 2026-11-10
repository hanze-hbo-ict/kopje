# Licensing (Phase 0 audit — not legal advice)

| Component | Licence | Shipped to users? | Obligations / plan |
|---|---|---|---|
| javaedit (this repo) | to be decided by the owner | yes | — |
| JavaBox (`vendor/javabox`) | MIT, © 2026 Brian Martin | glue `.mjs`, `jvm-main.c` (compiled into `.wasm`) | keep MIT notice in distributed `THIRD_PARTY_NOTICES` |
| OpenJDK 21u fork (`openjdk` submodule) | GPLv2 **with Classpath Exception** (+ Assembly Exception); per-module `legal/` notices | yes: HotSpot/libjava in `.wasm`, class library in `.data` | ship `/opt/jdk/legal/**` (already inside the image), offer corresponding source: link to the exact pinned fork commit `e339656c` and keep it available (a mirror/fork we control is safer than relying on upstream staying up) |
| libffi (`third-party/libffi-emscripten`) | MIT-style (Anthony Green, Red Hat et al.) | yes, in `.wasm` | include notice |
| Emscripten runtime glue | MIT / University of Illinois NCSA | yes | include notice |
| Mocha Doom (`container/doom`) | GPL (Mocha Doom) | **no** — excluded from our build | prebuilt currently contains `doom.jar` → must not be redistributed by us; Phase 3 build drops it |
| Freedoom IWAD | BSD-3-Clause | **no** | excluded |
| xterm.js (upstream demo) | MIT | no (not used) | — |
| Klode UI reference | unknown licence | no code copied | design reference only (Phase 4) |

**Distribution plan:** do not deploy the upstream prebuilt as-is (it contains Doom). Deploy a
Phase 3 source-built runtime, publish its exact source revisions and build script, include
`THIRD_PARTY_NOTICES` plus `legal/` from the jlink image.
