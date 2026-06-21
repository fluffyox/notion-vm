#!/usr/bin/env bash
# 把 src/ 下的拆分源码组装成单文件 dist/notion-vm.html
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p dist

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

printf '%s\n' \
  '<!doctype html>' \
  '<html lang="zh-CN">' \
  '<head>' \
  '<meta charset="utf-8">' \
  '<meta name="viewport" content="width=device-width, initial-scale=1">' \
  '<title>Notion 公式引擎 · 编译器 + 栈式虚拟机（教学）</title>' \
  '<style>' > "$tmp/pre"
printf '%s\n' '</style>' '</head>' '<body>' > "$tmp/mid1"
printf '%s\n' '<script>' > "$tmp/os"
printf '%s\n' '</script>' '<script>' > "$tmp/bs"
printf '%s\n' '</script>' '</body>' '</html>' > "$tmp/post"

cat "$tmp/pre" src/style.css "$tmp/mid1" src/body.html \
    "$tmp/os" src/engine.js "$tmp/bs" src/ui.js "$tmp/post" \
    > dist/notion-vm.html

echo "built dist/notion-vm.html ($(wc -c < dist/notion-vm.html) bytes, $(wc -l < dist/notion-vm.html) lines)"
