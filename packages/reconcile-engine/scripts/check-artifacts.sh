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

# Content hash of the Rust source tree, read from the WORKING TREE.
#
# This previously used `git ls-files -s`, which emits the *staged* blob hash —
# so uncommitted edits to rust/src did not move it, and this guard passed while
# the built artifacts were older than the source. That is precisely the case it
# exists to catch. --others --exclude-standard also covers a new module file
# that has not been git-added yet.
rust_tree_hash() {
  ( cd rust \
    && git ls-files --cached --others --exclude-standard -- src Cargo.toml Cargo.lock \
       | LC_ALL=C sort \
       | while IFS= read -r f; do
           [ -f "$f" ] || continue
           printf '%s %s\n' "$(git hash-object -- "$f")" "$f"
         done \
       | git hash-object --stdin )
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
