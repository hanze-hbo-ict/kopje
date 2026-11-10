# Building the runtime from source

```sh
git submodule update --init --recursive
brew install emscripten autoconf automake libtool grep   # emcc 5.0.2 tested
scripts/build-runtime-source.sh --modules minimal        # first run ~4 min on an M1 Pro
RUNTIME_DIR=~/kopje-build/out-minimal npm run build
```

`scripts/build-runtime-source.sh` (macOS/arm64 scripted; other hosts need the JDK set up by
hand):

1. **Copies** the pinned `vendor/javabox` checkout to `$KOPJE_BUILD_DIR/javabox`
   (default `~/kopje-build`). libtool and OpenJDK configure fail on paths with spaces,
   and this project lives under a path with spaces. It verifies the pinned commit.
2. **Downloads Temurin 21.0.10+7** (SHA-256 checked) and uses it as boot JDK, javac and
   jlink. It must match the HotSpot sources (`DEFAULT_VERSION_UPDATE=10` in the openjdk
   submodule); Homebrew's 21.0.13 produced a VM/class-library mismatch
   (`@IntrinsicCandidate` warnings at every boot).
3. Runs upstream `build-jvm-wasm.sh` and `build-jdk-native.sh` unchanged
   (`--skip-native` reuses previous results).
4. **Our jlink step** instead of upstream `build-jdk-modules.sh`: `--modules minimal` =
   `java.base,jdk.compiler,java.logging`; `--modules full` = upstream's 25-module list.
   The jimage is uncompressed (`--compress=zip-0`, override with `KOPJE_JLINK_COMPRESS`)
   because it gzips much better on the wire (10.3 MB vs 14.5 MB).
   Deletes `ct.sym` (only needed for `javac --release`), host natives, `jspawnhelper`,
   `shaders.metallib`; creates the placeholder `.so` files the static symbol table needs.
5. Builds `sun.nio.fs` for Emscripten (`scripts/build-nio-patch.sh`, ADR-8) into
   `/opt/jdk/patch/java.base`.
6. **Our link step** instead of upstream `link-direct-wasm.sh` (PLAN.md N1): our
   `runtime/native/jvm-main.c` (no Doom/audio/AWT natives, race-free stdin ring, JVM options
   incl. `--patch-module` and the E6 memory settings) and `runtime/native/no-sockets.js`
   (socket syscalls fail; SOCKFS not linked). Initial memory 128 MB, pthread pool 8
   (`KOPJE_INITIAL_MEMORY_MB`, `KOPJE_PTHREAD_POOL` override). The build fails if Doom
   symbols or a WebSocket client end up in the output. Writes `BUILD_INFO`.

| Runtime | `.wasm` | `.data` | Boot → ready (Chromium) |
|---|---:|---:|---:|
| Upstream prebuilt (with Doom) | 3.27 MB | 75.6 MB | 1.8 s |
| Source build, upstream modules, no Doom (JDK 21.0.13 jlink) | 3.20 MB | 45.5 MB | 1.9 s, mismatch warnings |
| Source build, upstream modules, JDK 21.0.10 jlink | 3.20 MB | 45.5 MB | 2.0 s |
| **Source build, minimal modules, no ct.sym** | 3.20 MB | **15.6 MB** | 2.0 s |

`scripts/prepare-runtime.mjs` assembles `public/runtime/<hash>/{host,driver,javabox}`: the
runtime iframe from `runtime/host/`, the compiled driver, the JavaBox files plus `.gz`
variants of `.wasm`/`.data`, and `runtime.json` (version, SHA-256s, build info). It writes the
versioned path to `src/runtime/runtime-location.generated.ts` (ADR-9). It prefers
`$RUNTIME_DIR`, then `~/kopje-build/out-minimal`, then `runtime-prebuilt/`.

On every JavaBox bump, diff `runtime/native/jvm-main.c` against upstream
`build/jvm-main.c`, and our link command against upstream `build/link-direct-wasm.sh`.
