#!/usr/bin/env bash
# Reproducible source build of the JavaBox runtime for javaedit (Phase 3).
#
#   scripts/build-runtime-source.sh [--modules full|minimal] [--skip-native]
#
# Steps:
#   1. copy the pinned vendor/javabox checkout (with submodules) to a path WITHOUT
#      spaces — libtool and OpenJDK configure fail on paths with spaces
#   2. fetch + verify Temurin JDK 21.0.10 (matches the HotSpot sources in the openjdk
#      submodule, DEFAULT_VERSION_UPDATE=10; a different update gives a VM/class-library
#      mismatch, visible as @IntrinsicCandidate warnings at boot)
#   3. upstream build-jvm-wasm.sh + build-jdk-native.sh (unchanged, incremental)
#   4. OUR jlink step (replaces upstream build-jdk-modules.sh): chosen module set,
#      no ct.sym, no Doom, no java.desktop
#   5. upstream link-direct-wasm.sh (without --with-doom)
#
# Output: $JAVAEDIT_BUILD_DIR/out-<modules>/javabox-direct.{mjs,wasm,data}
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
BUILD_DIR="${JAVAEDIT_BUILD_DIR:-$HOME/javaedit-build}"
case "$BUILD_DIR" in *" "*) echo "JAVAEDIT_BUILD_DIR must not contain spaces: $BUILD_DIR" >&2; exit 1 ;; esac
SRC="$BUILD_DIR/javabox"
OUT="$BUILD_DIR/out-$MODULE_SET"

JDK_VERSION="21.0.10+7"
JDK_SHA256_MAC_AARCH64="01ca390455216ca27bdddf8cfad51aaedb4f90e1e23aad9bfd9e90caaa2c5f1b"
JDK_URL_MAC_AARCH64="https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.10%2B7/OpenJDK21U-jdk_aarch64_mac_hotspot_21.0.10_7.tar.gz"
JDK_DIR="$BUILD_DIR/jdk-21.0.10"

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
fi
have="$(git -C "$SRC" rev-parse HEAD)"
[ "$have" = "$want" ] || { echo "ERROR: $SRC is at $have, expected pinned $want" >&2; exit 1; }

# 2. Version-matched JDK (used as boot JDK, javac and jlink).
if [ ! -x "$JDK_DIR/Contents/Home/bin/jlink" ]; then
  [ "$(uname -s)-$(uname -m)" = "Darwin-arm64" ] || { echo "Only macOS/arm64 is scripted; set up JDK $JDK_VERSION at $JDK_DIR manually." >&2; exit 1; }
  tmp="$BUILD_DIR/jdk.tar.gz"
  curl -fsSL -o "$tmp" "$JDK_URL_MAC_AARCH64"
  echo "$JDK_SHA256_MAC_AARCH64  $tmp" | shasum -a 256 -c -
  mkdir -p "$JDK_DIR" && tar -xzf "$tmp" -C "$JDK_DIR" --strip-components=1 && rm "$tmp"
fi
J="$JDK_DIR/Contents/Home"
export JAVA_HOME="$J" JAVABOX_BOOT_JDK="$J" JAVABOX_JDK21_HOME="$J" PATH="$J/bin:$PATH"

cd "$SRC"
# 3. Native libraries (upstream scripts, unchanged).
if [ "$SKIP_NATIVE" = false ]; then
  ./build/build-jvm-wasm.sh
  ./build/build-jdk-native.sh
fi

# 4. Class library.
rm -rf build/jdk-wasm
jlink --add-modules "$MODULES" --output build/jdk-wasm \
  --strip-debug --no-man-pages --no-header-files --compress=zip-6
rm -f build/jdk-wasm/lib/ct.sym                                   # only needed for javac --release
find build/jdk-wasm/lib \( -name '*.so' -o -name '*.dylib' \) -type f -size +0c -delete
find build/jdk-wasm/bin -type f -delete
rm -f build/jdk-wasm/lib/jspawnhelper build/jdk-wasm/lib/shaders.metallib
# Empty placeholders: System.loadLibrary must "find" the statically linked natives.
for lib in libjava libzip libnet libnio libjimage; do touch "build/jdk-wasm/lib/$lib.so"; done
"$J/bin/java" -version 2>&1 | head -1 > build/jdk-wasm/JAVAEDIT_JLINK_JDK
echo "modules: $MODULES" >> build/jdk-wasm/JAVAEDIT_JLINK_JDK

# 5. Link (no Doom).
rm -rf "$OUT"
./build/link-direct-wasm.sh "$OUT"
rm -f "$OUT/index.html" "$OUT/doom.html"
cp build/jdk-wasm/JAVAEDIT_JLINK_JDK "$OUT/BUILD_INFO"
{
  echo "javabox $(git rev-parse HEAD)"
  echo "openjdk $(git -C openjdk rev-parse HEAD)"
  echo "libffi  $(git -C third-party/libffi-emscripten rev-parse HEAD)"
  echo "emcc    $(emcc --version 2>/dev/null | head -1)"
} >> "$OUT/BUILD_INFO"
ls -l "$OUT"
cat "$OUT/BUILD_INFO"
