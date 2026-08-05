# rn-rust-db

[![CI](https://github.com/jakeymoreland/rn-rust-db/actions/workflows/ci.yml/badge.svg)](https://github.com/jakeymoreland/rn-rust-db/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

An offline-first **sync engine for React Native, with its core written in Rust**.
It's the on-device replica layer of a local-first app: it owns local storage,
field-level conflict resolution, change events, and a redis-style key–value
cache — and deliberately does **no networking**, so it drops into any backend.

> **Status: experimental.** The engine is tested, benchmarked, and audited, and
> both platforms autolink from an install — but the API is pre-1.0 and the
> prebuilt native artifacts are still built locally rather than distributed
> (see [Roadmap](./ROADMAP.md)). Not yet recommended for production.

## What it is

A React Native TurboModule (`@rn-experiments/reconcile-engine`) wrapping a Rust
core:

- **SQLite-backed store** with a field-level, last-writer-wins merge (timestamp
  then priority), keyed by a natural key — reconcile batches from any source and
  re-sending unchanged data is free (whole-payload + per-row content hashing).
- **redis-style kv cache** — memory-first with SQLite write-behind and
  coalescing (~1 µs get/set), for synchronous hot state.
- **Change events** (glob-matched pub/sub) delivered lock-free, so a subscriber
  can re-enter the engine without deadlocking.
- **Zero-copy JSI queries** — results cross to JS as an `ArrayBuffer` the JS side
  reads in place, with lazy views that materialize only the rows you touch.
- **No networking, by design.** Integration is always: `fetch()` → `ingest()` →
  reconcile → change event → re-query → UI. See [docs/INTEGRATIONS.md](./docs/INTEGRATIONS.md).

## Repository layout

| Path | What |
|---|---|
| `packages/reconcile-engine` | The engine: Rust core, C++/JSI glue, TS API. See its [README](./packages/reconcile-engine/README.md). |
| `apps/sandbox` | Expo app that hosts the engine and the benchmark suite. |
| `docs/INTEGRATIONS.md` | Wiring the engine into a real stack (Better Auth, Postgres/D1, sync loop). |
| `docs/superpowers/` | Design specs, the 2026-07-19 engine audit, and fix plans. |
| `BENCHMARKS.md` | Benchmark methodology and scoring. |
| `ROADMAP.md` | What's next and known gaps. |

## Quickstart

```bash
# Install workspace dependencies first (yarn v1, workspaces)
yarn install

# Build the Rust artifacts (see packages/reconcile-engine/README.md for toolchain setup)
cd packages/reconcile-engine
./scripts/build-ios.sh        # and/or ./scripts/build-android.sh

# Run the engine's test suites
(cd rust && cargo test) && yarn test

# Run the sandbox app + benchmarks
cd ../../apps/sandbox && yarn ios   # or yarn android
```

## Performance

Indicative simulator numbers (see `BENCHMARKS.md` for method; ratios are the
signal, absolute numbers are indicative):

- kv get / set: **~0.0007 / 0.0009 ms** — faster than the redis-style reference.
- Reaction/tick → change event: **~2 ms median**.
- 10k-row query as a zero-copy buffer + lazy view (materialize 20): **~0.58 ms**
  of pure marshaling (matches the industry reference); loading 10k rows to a
  usable, queryable view beats AsyncStorage/Realm/SQLite by 3–12×.
- Reliability suite (interrupted transaction, corrupted-payload recovery, retry
  idempotency, reopen integrity): **all passing**.

## Provenance

A full audit of the engine (see `docs/superpowers/audits/`) found and fixed 4
critical and 29 lower-severity issues — including timestamp handling that
silently broke last-writer-wins, a schema migration that could permanently brick
the database, and null-key records merging together — each fixed regression-test
first. That work is the reason the engine is stable enough to open up.

## License

MIT (see `LICENSE`) — that file governs this repository.

`apps/sandbox/LICENSE` is a different file: it is the MIT notice that shipped
with the Expo app template the sandbox was generated from, retained for the
scaffolding it covers. It is not the license of this project.
