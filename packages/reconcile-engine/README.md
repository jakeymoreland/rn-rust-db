# @rn-experiments/reconcile-engine

A React Native TurboModule wrapping a Rust reconcile engine (SQLite-backed store,
redis-style kv, field-level merge, pub/sub, zero-copy JSI queries).

## Prebuilt native artifacts are NOT committed

The Rust static libraries (`ios-rust/ReconcileEngine.xcframework`,
`android-rust/<abi>/libreconcile_engine.a`) are **gitignored** and must be built
from source before an app build (audit C4). Both `pod install` and the Android
CMake configure step run `scripts/check-artifacts.sh`, which fails fast with a
message if they are missing or stale — you will not get a silent
undefined-symbol link error.

### Bootstrap

```bash
# One-time toolchain setup (targets are also pinned in rust/rust-toolchain.toml)
rustup target add \
  aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios \
  aarch64-linux-android armv7-linux-androideabi x86_64-linux-android i686-linux-android
cargo install cargo-ndk          # Android only; also install the Android NDK

# Build the artifacts (writes artifacts-manifest.json used for drift detection)
./scripts/build-ios.sh
./scripts/build-android.sh
```

If you edit anything under `rust/`, re-run the build scripts. `check-artifacts.sh`
compares a hash of the Rust source tree against `artifacts-manifest.json` and
fails the app build if they diverge, so stale native code can't ship silently.

## Platform support

| Platform | Supported | Notes |
|---|---|---|
| iOS device (arm64) | ✅ | |
| iOS simulator (arm64 + x86_64) | ✅ | fat simulator slice, so Intel Macs build |
| Mac Catalyst | ❌ | no `ios-arm64-macabi` slice; `:mac_catalyst_enabled => false` |
| Android arm64-v8a / armeabi-v7a / x86_64 / x86 | ✅ | all four RN-default ABIs are built |

## Android: consumer integration is not automatic

The package has no `android/` gradle library project, so Android autolinking
contributes nothing — a consumer app must wire four things itself (this is
what `apps/sandbox/android` does; see those files as the reference):

1. **`jni/CMakeLists.txt`** — compile `cpp/NativeReconcileEngine.cpp` and import
   `android-rust/${ANDROID_ABI}/libreconcile_engine.a`. Resolve the package dir
   via `node --print require.resolve(...)` (not a fixed relative path) so it
   works from `node_modules`.
2. **`jni/OnLoad.cpp`** — an edited copy of RN's `default-app-setup/OnLoad.cpp`
   that registers `NativeReconcileEngine` in `cxxModuleProvider`. This tracks RN
   internals; on an RN upgrade, diff it against
   `node_modules/react-native/ReactAndroid/cmake-utils/default-app-setup/OnLoad.cpp`
   to catch upstream drift (audit F56).
3. **`app/build.gradle`** — a `generateAppLevelCodegen` task invoking RN's
   `scripts/generate-codegen-artifacts.js`, since a package with no `android/`
   project never gets library-level codegen run for it.
4. **`gradle.properties`** — `reactNativeArchitectures` may be narrowed for
   faster local builds, but all four ABIs are available.

Giving the package a real `android/` gradle library (so autolinking handles all
of the above) is tracked as a follow-up — see the audit report, finding S29.

## C ABI header

`cpp/include/engine.h` is a hand-maintained mirror of the `#[no_mangle]` exports
in `rust/src/ffi.rs` (14 functions). Keep them in sync on any signature change —
a silent divergence links cleanly but corrupts arguments at runtime (audit F54).
