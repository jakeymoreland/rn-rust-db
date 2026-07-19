#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/lib.sh"
PKG_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PKG_DIR/rust"

# Audit S26: preflight the toolchain instead of failing mid-build with a cryptic
# cargo/ndk error.
command -v cargo-ndk >/dev/null 2>&1 || {
  echo "ERROR: cargo-ndk not installed. Run: cargo install cargo-ndk (also needs the Android NDK)" >&2
  exit 1
}
require_targets aarch64-linux-android armv7-linux-androideabi x86_64-linux-android i686-linux-android

# Audit S49: build all four ABIs RN ships by default, not just arm64/x86_64.
# Audit S26: pin the min-SDK platform instead of inheriting cargo-ndk's default.
# Audit F53: build into target/ first; only replace $OUT after a full success,
# so a failed build can't delete the last working artifacts (which are
# gitignored and unrecoverable).
cargo ndk \
  -t arm64-v8a -t armeabi-v7a -t x86_64 -t x86 \
  --platform 24 \
  build --release

OUT="../android-rust"
STAGE="$(mktemp -d)"
mkdir -p "$STAGE/arm64-v8a" "$STAGE/armeabi-v7a" "$STAGE/x86_64" "$STAGE/x86"
cp target/aarch64-linux-android/release/libreconcile_engine.a "$STAGE/arm64-v8a/libreconcile_engine.a"
cp target/armv7-linux-androideabi/release/libreconcile_engine.a "$STAGE/armeabi-v7a/libreconcile_engine.a"
cp target/x86_64-linux-android/release/libreconcile_engine.a "$STAGE/x86_64/libreconcile_engine.a"
cp target/i686-linux-android/release/libreconcile_engine.a "$STAGE/x86/libreconcile_engine.a"

rm -rf "$OUT"
mkdir -p "$OUT"
cp -R "$STAGE"/. "$OUT"/

write_manifest "$PKG_DIR"
echo "Built static libs under $OUT/ (arm64-v8a, armeabi-v7a, x86_64, x86)"
