#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../rust"

cargo build --release --target aarch64-apple-ios
cargo build --release --target aarch64-apple-ios-sim

OUT="../ios-rust"
rm -rf "$OUT/ReconcileEngine.xcframework"
mkdir -p "$OUT"

xcodebuild -create-xcframework \
  -library target/aarch64-apple-ios/release/libreconcile_engine.a \
  -headers ../cpp/include \
  -library target/aarch64-apple-ios-sim/release/libreconcile_engine.a \
  -headers ../cpp/include \
  -output "$OUT/ReconcileEngine.xcframework"

echo "Built $OUT/ReconcileEngine.xcframework"
