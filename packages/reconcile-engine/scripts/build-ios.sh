#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/lib.sh"
PKG_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PKG_DIR/rust"

# Audit S26: fail early with guidance if a target is not installed.
require_targets aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios

# Build device + both simulator arches FIRST, so a failure leaves the existing
# xcframework untouched (the old rm-after-build ordering, kept — see F53).
cargo build --release --target aarch64-apple-ios
cargo build --release --target aarch64-apple-ios-sim
# Audit S28: also build the x86_64 simulator slice so Intel-Mac simulator
# builds link, then lipo the two sim arches into one fat slice.
cargo build --release --target x86_64-apple-ios

SIM_FAT="$(mktemp -d)/libreconcile_engine.a"
lipo -create \
  target/aarch64-apple-ios-sim/release/libreconcile_engine.a \
  target/x86_64-apple-ios/release/libreconcile_engine.a \
  -output "$SIM_FAT"

OUT="../ios-rust"
rm -rf "$OUT/ReconcileEngine.xcframework"
mkdir -p "$OUT"

xcodebuild -create-xcframework \
  -library target/aarch64-apple-ios/release/libreconcile_engine.a \
  -headers ../cpp/include \
  -library "$SIM_FAT" \
  -headers ../cpp/include \
  -output "$OUT/ReconcileEngine.xcframework"

write_manifest "$PKG_DIR"
echo "Built $OUT/ReconcileEngine.xcframework (device arm64 + simulator arm64/x86_64)"
