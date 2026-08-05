# Contributing

Thanks for helping on the reconcile engine. This is a Rust core behind a React
Native TurboModule, so a change often touches several layers — the notes below
keep them in sync.

## Prerequisites

- **Rust** — the toolchain and cross-compile targets are pinned in
  `packages/reconcile-engine/rust/rust-toolchain.toml`; rustup installs them
  automatically in that directory.
- **Node + yarn** for the TS API and the sandbox app.
- **iOS**: Xcode. The sandbox ships with no signing team set, so pick your own
  under Signing & Capabilities on first build (leave that change out of your
  PR). **Android**: the Android NDK and `cargo install cargo-ndk`.

## Layout

- `packages/reconcile-engine/rust` — the engine core (see the package
  [README](./packages/reconcile-engine/README.md)).
- `packages/reconcile-engine/cpp` — the C++/JSI glue and the C ABI header.
- `packages/reconcile-engine/src` — the TypeScript API.
- `apps/sandbox` — the host app and benchmark suite.

## Test-first, always

Every behavioral change lands **regression-test first**: write the failing test,
confirm it fails, implement the fix, confirm it passes. This is how the whole
engine audit was done and it's the bar for new work. Mechanical/doc changes need
a verifying command instead.

## Before you push, all of these must be green

```bash
cd packages/reconcile-engine/rust
cargo test
cargo clippy --all-targets -- -D warnings   # zero warnings — CI gates on this

cd ..                          # packages/reconcile-engine
yarn test

cd ../../apps/sandbox
npx tsc --noEmit
yarn test
```

## Layer-crossing rules

- **C ABI mirror.** `cpp/include/engine.h` is a hand-maintained mirror of the
  `#[no_mangle] extern "C"` exports in `rust/src/ffi.rs`. If you add or change an
  export, update the header in the same commit — a silent divergence links
  cleanly and corrupts arguments at runtime.
- **Rebuild native artifacts after touching `rust/`.** Run
  `scripts/build-ios.sh` and/or `scripts/build-android.sh`. They regenerate
  `artifacts-manifest.json`; `scripts/check-artifacts.sh` (run by pod install and
  the Android CMake configure) fails the app build if the committed artifacts
  drift from the source, so stale native code can't ship silently.
- **FFI safety.** Every `extern "C"` entry point is wrapped in `catch_unwind`,
  recovers from mutex poisoning, and validates the handle — keep new ones to the
  same pattern (see the existing functions in `ffi.rs`).

## Commits & PRs

- **Plain commit messages, no attribution or trailer footers.** Prefix with the
  area (`fix(reconcile):`, `perf(decode):`, `docs:`) as the history does.
- Branch off `main`; keep a PR scoped to one theme.
- Note in the PR whether you rebuilt native artifacts and which suites you ran.

## Where to start

`ROADMAP.md` lists the open work by theme. Good first areas: the testing/
benchmark items (sustained-load, memory, thermal) are additive and self-
contained; deciding how the prebuilt native artifacts get distributed is the
highest-impact blocker left.
