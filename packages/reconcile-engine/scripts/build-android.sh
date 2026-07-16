#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../rust"

OUT="../android-rust"
rm -rf "$OUT"
mkdir -p "$OUT"

cargo ndk -t arm64-v8a -t x86_64 build --release

mkdir -p "$OUT/arm64-v8a" "$OUT/x86_64"
cp target/aarch64-linux-android/release/libreconcile_engine.a "$OUT/arm64-v8a/libreconcile_engine.a"
cp target/x86_64-linux-android/release/libreconcile_engine.a "$OUT/x86_64/libreconcile_engine.a"

echo "Built static libs under $OUT/"
