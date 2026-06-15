#!/bin/sh
# コード複雑度チェック (ESLint 補完)
# ディレクトリ内ファイル数をチェックする
# ファイル行数・関数行数・循環的複雑度は ESLint で検査

set -eu

SRC_DIR="${1:-src}"
MAX_FILES_PER_DIR=15

echo "=== Directory File Count Check (max: ${MAX_FILES_PER_DIR}) ==="

violations_file=$(mktemp)
trap 'rm -f "$violations_file"' EXIT

find "$SRC_DIR" -type f -name "*.ts" ! -name "*.test.*" \
  | sed 's|/[^/]*$||' \
  | sort \
  | uniq -c \
  | sort -rn \
  | awk -v max="$MAX_FILES_PER_DIR" '$1 > max {print "  WARN: " $2 " has " $1 " files (max " max ")"}' \
  > "$violations_file"

if [ -s "$violations_file" ]; then
  cat "$violations_file"
  exit 1
else
  echo "  OK - all directories within limit"
  exit 0
fi
