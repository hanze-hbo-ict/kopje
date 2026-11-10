#!/usr/bin/env bash
# Reproducible source build of the JavaBox runtime for Kopje (Phase 3).
#
#   scripts/build-runtime-source.sh [--modules full|minimal] [--skip-native]
#
# Steps:
#   1. copy the pinned vendor/javabox checkout (with submodules) to a path WITHOUT
#      spaces — libtool and OpenJDK configure fail on paths with spaces
#   2. fetch + verify Temurin JDK 21.0.10 (matches the HotSpot sources in the openjdk
#      submodule, DEFAULT_VERSION_UPDATE=10; a different update gives a VM/class-library
#      mismatch, visible as @IntrinsicCandidate warnings at boot). The class library is
#      ALWAYS macOS/aarch64 (ADR-8). On macOS/arm64 that JDK also runs the build; on
#      Linux (x64, aarch64) a Linux JDK of the same version runs it and jlinks the macOS
#      jmods (cross-linking), so the runtime is the same on both build hosts.
#   3. upstream build-jvm-wasm.sh + build-jdk-native.sh (unchanged, incremental)
#   4. OUR jlink step (replaces upstream build-jdk-modules.sh): chosen module set,
#      no ct.sym, no Doom, no java.desktop; plus a java.base patch for sun.nio.fs built
#      against Emscripten's platform constants (scripts/build-nio-patch.sh)
#   5. OUR link step with runtime/native/jvm-main.c and runtime/native/no-sockets.js
#      (replaces upstream link-direct-wasm.sh; PLAN.md N1)
#
# Output: $KOPJE_BUILD_DIR/out-<modules>/javabox-direct.{mjs,wasm,data}
# Then:   RUNTIME_DIR=<that dir> npm run prepare:runtime
set -euo pipefail

MODULE_SET=minimal
SKIP_NATIVE=false
while [ $# -gt 0 ]; do
  case "$1" in
    --modules) MODULE_SET="$2"; shift 2 ;;
    --skip-native) SKIP_NATIVE=true; shift ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_DIR="${KOPJE_BUILD_DIR:-$HOME/kopje-build}"
case "$BUILD_DIR" in *" "*) echo "KOPJE_BUILD_DIR must not contain spaces: $BUILD_DIR" >&2; exit 1 ;; esac
SRC="$BUILD_DIR/javabox"
OUT="$BUILD_DIR/out-$MODULE_SET"

JDK_VERSION="21.0.10+7"
JDK_URL_BASE="https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.10%2B7"
# <archive> <sha256>, from Adoptium's published .sha256.txt files.
JDK_MAC_AARCH64="OpenJDK21U-jdk_aarch64_mac_hotspot_21.0.10_7.tar.gz 01ca390455216ca27bdddf8cfad51aaedb4f90e1e23aad9bfd9e90caaa2c5f1b"
JDK_LINUX_X64="OpenJDK21U-jdk_x64_linux_hotspot_21.0.10_7.tar.gz ea3b9bd464d6dd253e9a7accf59f7ccd2a36e4aa69640b7251e3370caef896a4"
JDK_LINUX_AARCH64="OpenJDK21U-jdk_aarch64_linux_hotspot_21.0.10_7.tar.gz 357fee29fb0d5c079f6730db98b28942df13a6eed426f6c61cd4ad703ab27b9a"
CLASSLIB_JDK_DIR="$BUILD_DIR/jdk-21.0.10"            # macOS/aarch64: the class library
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64)                 HOST_JDK=""; HOST_JDK_DIR="$CLASSLIB_JDK_DIR" ;;
  Linux-x86_64)                 HOST_JDK="$JDK_LINUX_X64"; HOST_JDK_DIR="$BUILD_DIR/jdk-21.0.10-linux" ;;
  Linux-aarch64|Linux-arm64)    HOST_JDK="$JDK_LINUX_AARCH64"; HOST_JDK_DIR="$BUILD_DIR/jdk-21.0.10-linux" ;;
  *) echo "Unsupported build host $(uname -s)-$(uname -m); use macOS/arm64 or Linux x64/aarch64." >&2; exit 1 ;;
esac

case "$MODULE_SET" in
  # Upstream's list (container/Dockerfile + build-jdk-modules.sh), for baseline comparison.
  full) MODULES="java.base,java.compiler,java.datatransfer,java.desktop,java.instrument,java.logging,java.management,java.naming,java.net.http,java.prefs,java.rmi,java.scripting,java.security.jgss,java.security.sasl,java.sql,java.sql.rowset,java.xml,java.xml.crypto,jdk.compiler,jdk.crypto.ec,jdk.httpserver,jdk.jshell,jdk.net,jdk.unsupported,jdk.zipfs" ;;
  # javac + transitive deps; java.logging is used by the driver's System.exit observer.
  # Add modules only when a compatibility test demonstrates the need (PLAN.md §6.1).
  minimal) MODULES="java.base,jdk.compiler,java.logging" ;;
  *) echo "--modules must be full or minimal" >&2; exit 2 ;;
esac

mkdir -p "$BUILD_DIR"

# 1. Space-free copy of the pinned sources (APFS clone: cheap).
want="$(git -C "$ROOT/vendor/javabox" rev-parse HEAD)"
if [ ! -d "$SRC/.git" ] && [ ! -f "$SRC/.git" ]; then
  cp -Rc "$ROOT/vendor/javabox" "$SRC" 2>/dev/null || cp -R "$ROOT/vendor/javabox" "$SRC"
  # In a fresh clone (e.g. CI) each submodule's .git is a file with a RELATIVE gitdir, which
  # is wrong in the copy; point the copy's gitfiles at the original repositories.
  for p in . $(git -C "$ROOT/vendor/javabox" submodule foreach --recursive --quiet 'echo "$displaypath"'); do
    if [ -f "$SRC/$p/.git" ]; then
      echo "gitdir: $(git -C "$ROOT/vendor/javabox/$p" rev-parse --absolute-git-dir)" > "$SRC/$p/.git"
    fi
  done
fi
have="$(git -C "$SRC" rev-parse HEAD)"
[ "$have" = "$want" ] || { echo "ERROR: $SRC is at $have, expected pinned $want" >&2; exit 1; }

# 2. Version-matched JDKs: the host JDK is boot JDK, javac and jlink; the macOS/aarch64 JDK
#    provides the class library (its jmods, and its java.base for compiling the NIO patch).
jdk_home() { if [ -d "$1/Contents/Home" ]; then echo "$1/Contents/Home"; else echo "$1"; fi; }
fetch_jdk() {   # <dir> "<archive> <sha256>"
  local dir="$1" archive="${2% *}" sha="${2#* }" tmp="$BUILD_DIR/jdk.tar.gz"
  [ -f "$(jdk_home "$dir")/jmods/java.base.jmod" ] && return
  curl -fsSL -o "$tmp" "$JDK_URL_BASE/$archive"
  if command -v sha256sum >/dev/null; then echo "$sha  $tmp" | sha256sum -c -; else echo "$sha  $tmp" | shasum -a 256 -c -; fi
  rm -rf "$dir" && mkdir -p "$dir" && tar -xzf "$tmp" -C "$dir" --strip-components=1 && rm "$tmp"
}
fetch_jdk "$CLASSLIB_JDK_DIR" "$JDK_MAC_AARCH64"
[ -n "$HOST_JDK" ] && fetch_jdk "$HOST_JDK_DIR" "$HOST_JDK"
J="$(jdk_home "$HOST_JDK_DIR")"
CLASSLIB="$(jdk_home "$CLASSLIB_JDK_DIR")"
export JAVA_HOME="$J" JAVABOX_BOOT_JDK="$J" JAVABOX_JDK21_HOME="$J" PATH="$J/bin:$PATH"

cd "$SRC"
# 3. Native libraries (upstream scripts, unchanged).
if [ "$SKIP_NATIVE" = false ]; then
  ./build/build-jvm-wasm.sh
  ./build/build-jdk-native.sh
fi

# 4. Class library.
rm -rf build/jdk-wasm
jlink --module-path "$CLASSLIB/jmods" --add-modules "$MODULES" --output build/jdk-wasm \
  --strip-debug --no-man-pages --no-header-files --compress="${KOPJE_JLINK_COMPRESS:-zip-0}"
# E5: uncompressed jimage (zip-0) gzips to 10.3 MB on the wire vs 14.5 MB for zip-6; boot time
# is unchanged; MEMFS then holds ~35 MB instead of ~16 MB per runtime (docs/baseline.md).
rm -f build/jdk-wasm/lib/ct.sym                                   # only needed for javac --release
find build/jdk-wasm/lib \( -name '*.so' -o -name '*.dylib' \) -type f -size +0c -delete
find build/jdk-wasm/bin -type f -delete
rm -f build/jdk-wasm/lib/jspawnhelper build/jdk-wasm/lib/shaders.metallib
# java.base patch: sun.nio.fs recompiled against Emscripten's UnixConstants (PLAN.md F1).
"$ROOT/scripts/build-nio-patch.sh" "$SRC/openjdk" "$J" build/jdk-wasm/patch "$CLASSLIB"
rm -f build/jdk-wasm/patch/UnixConstants.java.generated
# Empty placeholders: System.loadLibrary must "find" the statically linked natives.
for lib in libjava libzip libnet libnio libjimage; do touch "build/jdk-wasm/lib/$lib.so"; done
"$J/bin/java" -version 2>&1 | head -1 > build/jdk-wasm/KOPJE_JLINK_JDK
echo "modules: $MODULES" >> build/jdk-wasm/KOPJE_JLINK_JDK

# 5. Link with OUR entry point and link command (PLAN.md N1) instead of upstream
#    link-direct-wasm.sh: runtime/native/jvm-main.c (no Doom/audio/AWT natives, no
#    misplaced EM_JS hooks, race-free stdin ring, built-in --patch-module) and
#    runtime/native/no-sockets.js (socket syscalls fail; S3). Flags otherwise follow
#    upstream's link script; diff both on every JavaBox bump.
# E6: measured in docs/baseline.md; the heap grows to the JVM's reservations anyway.
INITIAL_MEMORY_MB="${KOPJE_INITIAL_MEMORY_MB:-128}"
PTHREAD_POOL="${KOPJE_PTHREAD_POOL:-8}"
LIBJVM="openjdk/build/emscripten-zero/jdk/lib/zero/libjvm.a"
NATIVE_LIBS=(build/jdk-native-wasm/libjava.a build/jdk-native-wasm/libjimage.a build/jdk-native-wasm/libzip.a build/jdk-native-wasm/libnio.a)
LIBFFI="third-party/libffi-emscripten/install/lib/libffi.a"
for f in "$LIBJVM" "${NATIVE_LIBS[@]}" "$LIBFFI"; do [ -f "$f" ] || { echo "ERROR: missing $f (run without --skip-native)" >&2; exit 1; }; done

LINK_DIR="build/kopje-link"
rm -rf "$LINK_DIR" && mkdir -p "$LINK_DIR"
emcc -c -O3 -pthread \
  -I openjdk/src/hotspot/share/include/ -I openjdk/src/hotspot/os/posix/include/ \
  -I openjdk/src/java.base/share/native/include/ -I openjdk/src/java.base/unix/native/include/ \
  "$ROOT/runtime/native/jvm-main.c" -o "$LINK_DIR/jvm-main.o"

# Static JNI symbol table (no dynamic loader in WASM; see upstream link-direct-wasm.sh).
LLVM_NM="$(em-config LLVM_ROOT)/llvm-nm"
SYMBOLS="$("$LLVM_NM" --defined-only "${NATIVE_LIBS[@]}" "$LINK_DIR/jvm-main.o" 2>/dev/null \
  | awk '$2 == "T" { print $3 }' \
  | grep -E '^(Java_|JNI_OnLoad|JNI_OnUnload|JIMAGE_|ZIP_|JDK_|JNU_|Agent_On|GetStringPlatformChars|VerifyClassForMajorVersion)' \
  | sort -u)"
{
  echo "/* Generated by scripts/build-runtime-source.sh - do not edit. */"
  echo "struct EmscriptenStaticSymbol { const char* name; void* addr; };"
  echo "$SYMBOLS" | sed 's/.*/extern void &(void);/'
  echo "const struct EmscriptenStaticSymbol emscripten_static_symbols[] = {"
  echo "$SYMBOLS" | sed 's/.*/  { "&", (void*) \&& },/'
  echo "  { 0, 0 }"
  echo "};"
} > "$LINK_DIR/static-symbols.c"
emcc -c -O3 -pthread "$LINK_DIR/static-symbols.c" -o "$LINK_DIR/static-symbols.o"

rm -rf "$OUT" && mkdir -p "$OUT"
em++ -O3 -mtail-call -pthread \
  -sUSE_PTHREADS=1 -sSHARED_MEMORY=1 \
  -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=$((INITIAL_MEMORY_MB * 1024 * 1024)) -sMAXIMUM_MEMORY=536870912 \
  -sPROXY_TO_PTHREAD=1 -sPTHREAD_POOL_SIZE="$PTHREAD_POOL" \
  -sSTACK_SIZE=4194304 -sDEFAULT_PTHREAD_STACK_SIZE=4194304 \
  -sSUPPORT_LONGJMP=wasm -fwasm-exceptions -sWASM_BIGINT \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createModule \
  -sEXPORTED_FUNCTIONS='["_main","_jvm_stdin_write","_jvm_enable_ring_buffer_stdin"]' \
  -sEXPORTED_RUNTIME_METHODS='["ccall","cwrap","FS","HEAPU8","addRunDependency","removeRunDependency"]' \
  -sERROR_ON_UNDEFINED_SYMBOLS=0 \
  --js-library "$ROOT/runtime/native/no-sockets.js" \
  "$LINK_DIR/jvm-main.o" "$LINK_DIR/static-symbols.o" \
  -Wl,--whole-archive "$LIBJVM" "${NATIVE_LIBS[@]}" -Wl,--no-whole-archive "$LIBFFI" \
  --preload-file "build/jdk-wasm@/opt/jdk" \
  -o "$OUT/javabox-direct.mjs"

# Checks: no Doom/AWT symbols, no socket backend.
if grep -q -E 'jvm_doom|jvm_audio|CanvasRenderer|WebAudioSoundDriver' "$OUT/javabox-direct.mjs" "$LINK_DIR/static-symbols.c"; then
  echo "ERROR: Doom/audio symbols still present" >&2; exit 1
fi
if grep -q 'WebSocket' "$OUT/javabox-direct.mjs"; then
  echo "ERROR: socket backend (SOCKFS/WebSocket) still linked" >&2; exit 1
fi
cp build/jdk-wasm/KOPJE_JLINK_JDK "$OUT/BUILD_INFO"
echo "link: own jvm-main.c + no-sockets.js; INITIAL_MEMORY=${INITIAL_MEMORY_MB}MB PTHREAD_POOL_SIZE=${PTHREAD_POOL}" >> "$OUT/BUILD_INFO"
[ -n "$HOST_JDK" ] && echo "build host: $(uname -s)-$(uname -m), cross-linked macos-aarch64 jmods" >> "$OUT/BUILD_INFO"
{
  echo "javabox $(git rev-parse HEAD)"
  echo "openjdk $(git -C openjdk rev-parse HEAD)"
  echo "libffi  $(git -C third-party/libffi-emscripten rev-parse HEAD)"
  echo "emcc    $(emcc --version 2>/dev/null | head -1)"
} >> "$OUT/BUILD_INFO"
ls -l "$OUT"
cat "$OUT/BUILD_INFO"
