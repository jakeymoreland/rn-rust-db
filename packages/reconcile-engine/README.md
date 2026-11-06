# @rn-experiments/reconcile-engine

The React Native module in this repo. Register a feed, ingest its payload, read
the merged row. Rust owns SQLite. The merge is per field. A tombstone removes a
row when its version wins.

It was built for an app whose records arrive from more than one place and
cannot be reconciled upstream. Sync engines replicate a single backend.
SQLite wrappers store what you insert. This is the step between those: several
payloads in, one local row out, with the work off the JavaScript thread. The
root [README](../../README.md) is the full account of that, and the numbers
against raw SQLite.

`openEngine()` installs the host functions. `ingest()` then copies the payload
in 256 KB slices and the native worker reconciles on the last slice. You do
not call `installFastPath()` yourself unless you are driving the TurboModule
`open` directly.

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

## Ingest off the JS thread

`installFastPath()` installs `ingestAppend` and `queryPageAsync`. After that,
`ingest()` slices the payload into 256 KB pieces, copies one piece per turn,
and lets the native worker concatenate and reconcile when the last piece
arrives. `ingestChunked(sourceId, bytes)` does the same for a `Uint8Array`
that is already bytes (a `fetch` `arrayBuffer`). `forEachPage` walks a
collection one zero-copy schema-buffer page at a time; the query runs on the
reader worker.

`ingestBufferSync` is still installed. It runs the whole ingest on the JS
thread and exists so the boundary bench can time that path. Do not call it
from a screen.

## Tombstones and the clock

A record with `"_deleted": true` is a tombstone. It hides the row when its
version wins, and a newer update brings the row back. `snapshot: true` on a
source treats each batch as the full key set and tombstones omissions.

Versions compare `(physical, logical, priority, source_id, value)`. A source
timestamp more than `RECONCILE_MAX_SKEW_MS` (default 5 minutes) ahead of a
real local clock is clamped. Rows with no timestamp take a hybrid-clock tick
that does not go backwards. Tombstones older than `RECONCILE_TOMBSTONE_TTL_MS`
(default 7 days) are compacted, and never inside the skew window.
`compactTombstones` runs it on demand.

This tie-break is a total order. Two batches that carry the same timestamps
converge whichever arrives first. Previously a cross-source tie kept whichever
row was already stored, and a second ingest from the same source at the same
timestamp won because it arrived later. Callers who need last-arrival-wins
across separate requests have to send a strictly greater timestamp.

## Reading rows: use the windowed path

`installFastPath()` installs synchronous JSI query functions on the JS thread.
Synchronous means each call occupies the JS thread for its full duration, so
anything past the ~16.7 ms frame budget drops frames regardless of how fast the
engine is. Measured on an iPhone 16 Pro over a 10,000-row collection:

| call | ms | |
|---|---:|---|
| `queryEntriesSchemaBufferRange` (50-row page) | **3.6** | cost tracks the page, not the collection |
| `queryEntriesBuffer` + lazy view | 7.2 | one zero-copy buffer, rows materialize on touch |
| `queryEntriesObjects` (all rows) | 39.8 | deprecated — a JS object per row |
| `queryEntriesSchemaBuffer` (all rows) | **245.2** | deprecated — 67x the windowed page |

The windowed call is roughly flat as the collection grows; the two deprecated
ones are linear in collection size. Reach for a page, or for the lazy buffer
when you genuinely need the whole set.

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
