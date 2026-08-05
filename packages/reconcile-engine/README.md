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

## Android: autolinked, no app-side wiring

The package ships an `android/` gradle library, so a consumer app needs no
CMake, no `OnLoad.cpp`, and no codegen task of its own — `yarn add` plus a
native rebuild is the whole integration (audit S29). `apps/sandbox/android` is
the proof: its `app/build.gradle` has no `externalNativeBuild` block at all.

How the pieces fit, since C++ TurboModules autolink differently from Java ones:

| Piece | What it does |
|---|---|
| `android/build.gradle` | Applies `com.facebook.react` to a library project, which runs library-level codegen into `android/build/generated/source/codegen/` (the `ReconcileEngineSpec` JSI header and the `react_codegen_ReconcileEngineSpec` CMake target). |
| `android/src/main/jni/CMakeLists.txt` | Compiles `cpp/NativeReconcileEngine.cpp` and links `android-rust/${ANDROID_ABI}/libreconcile_engine.a` into the target `reconcile_engine_cxx`. |
| `react-native.config.js` | Points autolinking at that CMakeLists (`cxxModuleCMakeListsPath`) and at the header (`cxxModuleHeaderName`), so the generated `autolinking.cpp` constructs the module in `autolinking_cxxModuleProvider`. |
| `ReconcileEnginePackage.kt` | Empty by design. The autolinking resolver drops a library's whole Android config unless it finds a `ReactPackage` class, so this exists purely to be found. |

Nothing is built into a `.so` of the library's own: autolinking `add_subdirectory`s
both CMake projects into the app's `libappmodules.so`, which is also where the
generated `autolinking.cpp` lands — the module and its registration end up in
one binary.

Because nothing lives in the app's own native project any more, a regenerating
`expo prebuild` has nothing of ours to clobber.

`reactNativeArchitectures` in the app's `gradle.properties` may be narrowed for
faster local builds; all four RN-default ABIs are available.

## Never run Expo/CLI commands inside this package

`npx expo run:ios` (or any `expo prebuild`) executed with this directory as the
working directory treats the package as an app: it adds `expo`, `react` and
`react-native` to this package's `dependencies`, scaffolds an `app.json` and a
full `ios/` Xcode project here, and **deletes `ios/ReconcileEngineProvider.{h,mm}`**
— the iOS TurboModule provider — because prebuild owns that directory in an app.

Build the app from `apps/sandbox`, and this package's native artifacts with
`./scripts/build-ios.sh` / `./scripts/build-android.sh` only.

## C ABI header

`cpp/include/engine.h` is a hand-maintained mirror of the `#[no_mangle]` exports
in `rust/src/ffi.rs` (14 functions). Keep them in sync on any signature change —
a silent divergence links cleanly but corrupts arguments at runtime (audit F54).
