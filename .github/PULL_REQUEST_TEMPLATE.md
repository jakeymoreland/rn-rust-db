## What and why

<!-- What changes, and what problem it solves. Link the issue if there is one. -->

## Layers touched

<!-- A change often spans several. Tick what this PR actually touches. -->

- [ ] Rust core (`packages/reconcile-engine/rust`)
- [ ] C++/JSI glue or the C ABI header (`packages/reconcile-engine/cpp`)
- [ ] TypeScript API (`packages/reconcile-engine/src`)
- [ ] Sandbox app / benchmarks (`apps/sandbox`)
- [ ] Docs only

If the C ABI header changed, say here how the other side was kept in sync.

## Verification

Paste the output, don't just tick the box:

```
cd packages/reconcile-engine/rust && cargo test && cargo clippy --all-targets -- -D warnings
cd .. && yarn test
cd ../../apps/sandbox && npx tsc --noEmit && yarn test
```

- [ ] Behavioral change landed **regression-test first** (failing test, then the
      fix) — see CONTRIBUTING.md. Mechanical/doc changes: name the verifying
      command instead.
- [ ] Rust artifacts rebuilt (`scripts/build-ios.sh` / `build-android.sh`) if
      anything under `rust/` changed.

## Benchmarks

<!-- If this touches a hot path (ingest, query, decode, kv), include before/after
     numbers and say which device or simulator produced them. Otherwise: n/a. -->
