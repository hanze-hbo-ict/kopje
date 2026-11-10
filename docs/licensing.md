# Licensing (Phase 0 audit — not legal advice)

| Component | Licence | Shipped to users? | Obligations / plan |
|---|---|---|---|
| javaedit (this repo) | to be decided by the owner | yes | — |
| JavaBox (`vendor/javabox`) | MIT, © 2026 Brian Martin | glue `.mjs`, `jvm-main.c` (compiled into `.wasm`) | keep MIT notice in distributed `THIRD_PARTY_NOTICES` |
| OpenJDK 21u fork (`openjdk` submodule) | GPLv2 **with Classpath Exception** (+ Assembly Exception); per-module `legal/` notices | yes: HotSpot/libjava in `.wasm`, class library in `.data` | ship `/opt/jdk/legal/**` (already inside the image), offer corresponding source by linking to the exact pinned commits (OpenJDK fork `e339656c`, JavaBox `506756b`, libffi `0b72a27`) in `THIRD_PARTY_NOTICES.txt`. **Decision (2026-11-10):** source availability is left to the upstream repositories; no own mirror or source archive. Residual risk: if upstream removes them, the link no longer satisfies the source offer. |
| libffi (`third-party/libffi-emscripten`) | MIT-style (Anthony Green, Red Hat et al.) | yes, in `.wasm` | include notice |
| Emscripten runtime glue | MIT / University of Illinois NCSA | yes | include notice |
| Mocha Doom (`container/doom`) | GPL (Mocha Doom) | **no** — excluded from our build | prebuilt currently contains `doom.jar` → must not be redistributed by us; Phase 3 build drops it |
| Freedoom IWAD | BSD-3-Clause | **no** | excluded |
| xterm.js (upstream demo) | MIT | no (not used) | — |
| Klode UI reference | unknown licence | no code copied | design reference only (Phase 4) |

**Distribution plan:** do not deploy the upstream prebuilt as-is (it contains Doom). Deploy a
Phase 3 source-built runtime, publish its exact source revisions and build script, include
`THIRD_PARTY_NOTICES` plus `legal/` from the jlink image.
