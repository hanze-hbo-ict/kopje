#!/usr/bin/env bash
# Build a java.base patch that makes java.nio.file work on Emscripten (PLAN.md F1).
#
#   scripts/build-nio-patch.sh <openjdk-src> <jdk-home> <out-dir>
#
# Why: JavaBox runs the *macOS* class library on natives built for Emscripten. The class
# sun.nio.fs.UnixConstants is generated per target from C headers, and its values are
# compile-time constants inlined into every sun.nio.fs class. On macOS, O_CREAT=512, which
# is O_TRUNC on Emscripten, and every errno differs (Emscripten uses WASI numbering), so
# NIO opens files with the wrong flags and misreads errors.
#
# What: generate UnixConstants.java from the pinned OpenJDK template with Emscripten's
# preprocessor (as OpenJDK's GensrcMisc does for a real target), then recompile the whole
# sun.nio.fs package (share + unix + macosx sources of the same OpenJDK revision) against
# it. The result is loaded with --patch-module=java.base=<out-dir>/java.base.
set -euo pipefail
SRC="${1:?openjdk source dir}"; JDK="${2:?jdk home}"; OUT="${3:?output dir}"
TEMPLATE="$SRC/src/java.base/unix/classes/sun/nio/fs/UnixConstants.java.template"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

mkdir -p "$WORK/gensrc/sun/nio/fs"
GEN="$WORK/gensrc/sun/nio/fs/UnixConstants.java"
# Same steps as OpenJDK's generate-preproc-src: preprocess, drop the C preamble, strip PREFIX_.
emcc -E -P -x c "$TEMPLATE" \
  | sed -n '/@@START_HERE@@/,$p' | sed '1d' | sed 's/PREFIX_//g' > "$GEN"

# macOS-only constants (#ifdef _ALLBSD_SOURCE in the template). Emscripten has no
# <sys/attr.h> / <sys/clonefile.h>; they are only passed to macOS natives that are not
# linked into the runtime, but the macOS sun.nio.fs classes need them to compile.
python3 - "$GEN" <<'EOF'
import sys, re
p = sys.argv[1]
s = open(p).read()
extra = {
  'CLONE_NOFOLLOW': 1, 'CLONE_NOOWNERCOPY': 2,
  'ATTR_CMN_CRTIME': 512, 'ATTR_CMN_MODTIME': 1024, 'ATTR_CMN_ACCTIME': 4096,
  'FSOPT_NOFOLLOW': 1,
  'ENOTSUP': 138,   # a real errno on Emscripten (WASI numbering); only the #ifdef hides it
}
lines = ''.join(f'    static final int {k} = {v}; // macOS-only, unused on Emscripten\n'
                for k, v in extra.items() if not re.search(rf'\b{k}\b\s*=', s))
s = s[:s.rstrip().rfind('}')] + lines + '}\n'
open(p, 'w').write(s)
EOF

# The macOS file system calls two natives that are not linked into the Emscripten runtime
# (clonefile, fcopyfile). Make them report "unsupported" so UnixFileSystem falls back to its
# portable buffered copy (bufferedCopy0, which is linked). Each edit is asserted, so an
# upstream change fails the build instead of silently not applying.
OVERRIDE="$WORK/override"
mkdir -p "$OVERRIDE"
python3 - "$SRC/src/java.base/macosx/classes/sun/nio/fs/BsdFileSystem.java" "$OVERRIDE/BsdFileSystem.java" <<'EOF2'
import sys
src, dst = sys.argv[1], sys.argv[2]
s = open(src).read()
edits = [
    ("        int flags = followLinks ? 0 : CLONE_NOFOLLOW;\n",
     "        if (true) return IOStatus.UNSUPPORTED_CASE; // Kopje: no clonefile on Emscripten\n"
     "        int flags = followLinks ? 0 : CLONE_NOFOLLOW;\n"),
    ("        return directCopy0(dst, src, addressToPollForCancel);\n",
     "        return IOStatus.UNSUPPORTED; // Kopje: no fcopyfile on Emscripten; use bufferedCopy\n"),
]
for old, new in edits:
    if s.count(old) != 1:
        sys.exit(f"ERROR: BsdFileSystem.java edit did not apply exactly once: {old.strip()!r}")
    s = s.replace(old, new)
open(dst, 'w').write(s)
EOF2

# Compile the whole package against the generated constants, as members of java.base.
SOURCES=()
for d in share unix macosx; do
  for f in "$SRC/src/java.base/$d/classes/sun/nio/fs/"*.java; do
    [ -e "$f" ] || continue
    name="$(basename "$f")"
    [ "$name" = "UnixConstants.java" ] && continue
    if [ -e "$OVERRIDE/$name" ]; then SOURCES+=("$OVERRIDE/$name"); else SOURCES+=("$f"); fi
  done
done
SOURCES+=("$GEN")

rm -rf "$OUT" && mkdir -p "$OUT/java.base"
if ! "$JDK/bin/javac" -nowarn -XDignore.symbol.file \
      --patch-module java.base="$WORK/gensrc" \
      -d "$OUT/java.base" "${SOURCES[@]}" > "$WORK/javac.log" 2>&1; then
  cat "$WORK/javac.log" >&2
  echo "ERROR: patch compile failed" >&2
  rm -rf "$OUT"
  exit 1
fi

# Sanity: compiled values must be Emscripten's (header literals may be octal, e.g. 0100).
CONSTS="$("$JDK/bin/javap" -constants -p "$OUT/java.base/sun/nio/fs/UnixConstants.class")"
for want in 'O_CREAT = 64;' 'O_TRUNC = 512;' 'ENOENT = 44;' 'EEXIST = 20;'; do
  grep -q "int $want" <<<"$CONSTS" || { echo "ERROR: expected $want in generated UnixConstants" >&2; exit 1; }
done
cp "$GEN" "$OUT/UnixConstants.java.generated"
echo "nio patch: $(find "$OUT/java.base" -name '*.class' | wc -l | tr -d ' ') classes in $OUT/java.base"
