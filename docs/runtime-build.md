# Building the runtime from source

```sh
git submodule update --init --recursive
brew install emscripten autoconf automake libtool grep   # emcc 5.0.2 tested
scripts/build-runtime-source.sh --modules minimal        # first run ~4 min on an M1 Pro
RUNTIME_DIR=~/javaedit-build/out-minimal npm run build
```

`scripts/build-runtime-source.sh` (macOS/arm64 scripted; other hosts need the JDK set up by
hand):

1. **Copies** the pinned `vendor/javabox` checkout to `$JAVAEDIT_BUILD_DIR/javabox`
   (default `~/javaedit-build`). libtool and OpenJDK configure fail on paths with spaces,
   and this project lives under a path with spaces. It verifies the pinned commit.
2. **Downloads Temurin 21.0.10+7** (SHA-256 checked) and uses it as boot JDK, javac and
   jlink. It must match the HotSpot sources (`DEFAULT_VERSION_UPDATE=10` in the openjdk
   submodule); Homebrew's 21.0.13 produced a VM/class-library mismatch
   (`@IntrinsicCandidate` warnings at every boot).
3. Runs upstream `build-jvm-wasm.sh` and `build-jdk-native.sh` unchanged
   (`--skip-native` reuses previous results).
4. **Our jlink step** instead of upstream `build-jdk-modules.sh`: `--modules minimal` =
   `java.base,jdk.compiler,java.logging`; `--modules full` = upstream's 25-module list.
   Deletes `ct.sym` (only needed for `javac --release`), host natives, `jspawnhelper`,
   `shaders.metallib`; creates the placeholder `.so` files the static symbol table needs.
5. Runs upstream `link-direct-wasm.sh` without `--with-doom`; writes `BUILD_INFO` with all
   revisions and the jlink JDK.

| Runtime | `.wasm` | `.data` | Boot → ready (Chromium) |
|---|---:|---:|---:|
| Upstream prebuilt (with Doom) | 3.27 MB | 75.6 MB | 1.8 s |
| Source build, upstream modules, no Doom (JDK 21.0.13 jlink) | 3.20 MB | 45.5 MB | 1.9 s, mismatch warnings |
| Source build, upstream modules, JDK 21.0.10 jlink | 3.20 MB | 45.5 MB | 2.0 s |
| **Source build, minimal modules, no ct.sym** | 3.20 MB | **15.6 MB** | 2.0 s |

`scripts/prepare-runtime.mjs` copies a runtime into `public/runtime/javabox/` (plus
`runtime.json` with SHA-256s) and compiles the driver into `public/runtime/driver/`. It
prefers `$RUNTIME_DIR`, then `~/javaedit-build/out-minimal`, then `runtime-prebuilt/`.

Not yet done (would require forking JavaBox): removing the Doom/AWT native stubs from
`jvm-main.c`, fixing the stdin futex race and `available()` upstream, overriding socket
syscalls.
