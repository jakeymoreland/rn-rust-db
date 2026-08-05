---
name: Bug report
about: Something in the engine, the bridge, or the build behaves wrong
title: ''
labels: bug
assignees: ''
---

## What happened

<!-- And what you expected instead. -->

## Where

- [ ] Rust core
- [ ] C++/JSI bridge or native build
- [ ] TypeScript API
- [ ] Sandbox app / benchmarks
- [ ] Not sure

## Environment

- Platform and arch: <!-- iOS sim arm64 / iOS device / Android emulator x86_64 / etc. -->
- OS version:
- React Native / Expo version:
- Host: <!-- apps/sandbox, or your own app -->
- Rust toolchain: <!-- `rustc --version` -->

## Native artifacts

Stale prebuilt artifacts cause most confusing failures — the Rust binaries are
gitignored and built locally.

- [ ] I rebuilt with `scripts/build-ios.sh` / `scripts/build-android.sh` after
      my last change under `rust/`
- [ ] `bash scripts/check-artifacts.sh` passes

## Reproduction

<!-- Smallest sequence of engine calls that shows it: the source registration,
     the ingest payload shape, and the query. A failing `cargo test` or jest
     test is the ideal form. -->

```
```

## Logs

<!-- Rust panics, the `ok:false` error envelope, or the native link error. -->

```
```
