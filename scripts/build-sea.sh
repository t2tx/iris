#!/bin/sh
# Build a single-executable (SEA) binary of Iris — no Node required to run.
# Supports macOS, Linux, and Windows (via Git Bash).
#
#   sh scripts/build-sea.sh
#
# Output: dist-sea/iris  (a standalone binary)
#
# Steps: esbuild bundle → SEA blob → copy node → inject blob → codesign (macOS).
# Requires: Node 20+ (for node:sea), esbuild (devDependency).
set -e

OUT_DIR="dist-sea"
BUNDLE="$OUT_DIR/iris.cjs"
BLOB="$OUT_DIR/iris.blob"
OS="$(uname -s)"
case "$OS" in
  MINGW*|MSYS*|CYGWIN*) OS="Windows" ;;
esac
if [ "$OS" = "Windows" ]; then
  BIN="$OUT_DIR/iris.exe"
else
  BIN="$OUT_DIR/iris"
fi

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

echo "1/5 bundle (esbuild)…"
# CJS bundle. import.meta.url is only referenced on non-SEA paths (isSea() is
# true in the binary, so those branches never run). We do NOT define it away —
# doing so broke createRequire(import.meta.url). Inject the package version so
# `iris --version` works without a bundled package.json.
VERSION="$(node -p "require('./package.json').version")"
node_modules/.bin/esbuild src/cli.ts \
  --bundle --platform=node --target=node22 --format=cjs \
  --outfile="$BUNDLE" \
  --define:__IRIS_VERSION__="\"$VERSION\"" 2>/dev/null

echo "2/5 generate SEA blob…"
node --experimental-sea-config sea-config.json

echo "3/5 copy node binary…"
# Use the real binary, not a nodenv/asdf shim (which is a shell script).
REAL_NODE="$(node -p 'process.execPath')"
cp "$REAL_NODE" "$BIN"
# macOS: remove the signature so we can re-sign after injection.
if [ "$OS" = "Darwin" ]; then
  codesign --remove-signature "$BIN" 2>/dev/null || true
fi

echo "4/5 inject blob…"
POSTJECT_ARGS="$BIN NODE_SEA_BLOB $BLOB --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2"
if [ "$OS" = "Darwin" ]; then
  npx --yes postject $POSTJECT_ARGS --macho-segment-name NODE_SEA
else
  npx --yes postject $POSTJECT_ARGS
fi

echo "5/5 finalize…"
if [ "$OS" = "Darwin" ]; then
  codesign --sign - "$BIN"
  echo "ad-hoc codesigned (macOS)"
fi

echo "done → $BIN"
ls -lh "$BIN" | awk '{print $5, $NF}'
