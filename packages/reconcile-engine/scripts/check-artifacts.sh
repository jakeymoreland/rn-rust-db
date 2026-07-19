#!/usr/bin/env bash
# Fails fast (audit C4/S25) when the prebuilt Rust artifacts are missing or have
# drifted from the current source. Run by pod install (prepare_command) and the
# Android CMake configure step so a stale/absent binary produces a clear message
# instead of an undefined-symbol link error or silently-old native code.
set -euo pipefail
cd "$(dirname "$0")/.."

IOS="ios-rust/ReconcileEngine.xcframework"
ANDROID="android-rust"
MANIFEST="artifacts-manifest.json"

fail() {
  echo "ERROR (reconcile-engine): $1" >&2
  echo "  The Rust engine artifacts are not built or are stale. Build them with:" >&2
  echo "    rustup target add aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios \\" >&2
  echo "      aarch64-linux-android armv7-linux-androideabi x86_64-linux-android i686-linux-android" >&2
  echo "    cargo install cargo-ndk    # Android only; also needs the Android NDK" >&2
  echo "    ./scripts/build-ios.sh && ./scripts/build-android.sh" >&2
  exit 1
}

# rust source tree hash — stable across machines (sorted tracked files).
rust_tree_hash() {
  ( cd rust && git ls-files src Cargo.toml Cargo.lock | LC_ALL=C sort \
      | git hash-object --stdin-paths | git hash-object --stdin )
}

[ -d "$IOS" ] || fail "missing iOS xcframework ($IOS)"
[ -d "$ANDROID/arm64-v8a" ] || fail "missing Android arm64-v8a lib ($ANDROID/arm64-v8a)"
[ -f "$MANIFEST" ] || fail "missing $MANIFEST (rebuild to regenerate)"

want=$(rust_tree_hash)
have=$(grep -o '"rust_tree_hash": *"[^"]*"' "$MANIFEST" | sed 's/.*"\([^"]*\)"$/\1/')
if [ "$want" != "$have" ]; then
  fail "source has changed since the artifacts were built (rust_tree_hash $have != $want)"
fi

echo "reconcile-engine: artifacts present and match source ($want)"
