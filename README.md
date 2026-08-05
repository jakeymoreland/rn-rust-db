# rn-rust-db

[![CI](https://github.com/jakeymoreland/rn-rust-db/actions/workflows/ci.yml/badge.svg)](https://github.com/jakeymoreland/rn-rust-db/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

An **on-device reconciler for multi-source data in React Native**, with its core
written in Rust. When the same record reaches you from several feeds you don't
control — in different formats, carrying different fields, at different levels of
trust — this decides what the record actually *is*, per field, on the device.

> **Status: experimental.** The engine is tested, benchmarked, and audited, and
> both platforms autolink from an install — but the API is pre-1.0 and the
> prebuilt native artifacts are still built locally rather than distributed
> (see [Roadmap](./ROADMAP.md)). Not yet recommended for production.

## The thing it does that a sync engine doesn't

Three feeds describe the same people. They disagree.

```ts
// JSON from your API, CSV from a partner, JSON from the device itself.
// Same collection, same natural key, different fields, different freshness.
await registerSource({ source_id: 'api',     format: 'Json', collection: 'people',
                       natural_key_field: 'email', timestamp_field: 'updatedAt', priority: 10 });
await registerSource({ source_id: 'partner', format: 'Csv',  collection: 'people',
                       natural_key_field: 'email', timestamp_field: 'as_of',     priority: 5  });
await registerSource({ source_id: 'device',  format: 'Json', collection: 'people',
                       natural_key_field: 'email', timestamp_field: 'seenAt',    priority: 20 });

await ingest('api',     '[{"email":"ann@x.com","name":"Ann","city":"Sydney",'
                      + '"updatedAt":"2026-08-05T09:00:00Z"}]');
await ingest('partner', 'email,name,phone,as_of\n'
                      + 'ann@x.com,Annie,0400 111 222,2026-08-05T08:00:00Z\n');
await ingest('device',  '[{"email":"ann@x.com","lastSeen":"2026-08-05T09:05:00Z",'
                      + '"seenAt":"2026-08-05T09:05:00Z"}]');

// ann@x.com is now one record:
//   name     "Ann"            — api (09:00) beat partner (08:00) on recency
//   phone    "0400 111 222"   — partner is older and lowest priority, but it is
//                               the only feed carrying phone, so it still lands
//   city     "Sydney"         — only api had it
//   lastSeen "…T09:05:00Z"    — device
```

Merge is **per field**, not per record — that's why the oldest, least-trusted
feed still contributes `phone`. Re-sending an unchanged payload costs nothing
(whole-payload hash skip plus a per-row content-hash short-circuit), so polling
the same endpoint on a timer is cheap by construction. Rows that don't parse go
to a dead-letter queue instead of failing the batch.

**The ordering rule, exactly:** a field is overwritten when the incoming record's
timestamp is newer; on an exact tie, higher `priority` wins; on a tie at equal
priority the existing value stays, except from the same source, where the later
record in the batch is treated as a correction. Timestamp dominates — `priority`
is a tie-breaker, not a trust override.

> **Configure `timestamp_field` on every feed that carries one.** A source with
> `timestamp_field: null` is stamped at *ingest* time, which means a stale import
> will read as "just observed" and outrank a fresher value from a feed that dates
> itself honestly.

## What it is

A React Native TurboModule (`@rn-experiments/reconcile-engine`) wrapping a Rust
core:

- **SQLite-backed store** with the field-level, last-writer-wins merge above
  (timestamp then priority), keyed by a natural key.
- **redis-style kv cache** — memory-first with SQLite write-behind and
  coalescing (~1 µs get/set), for synchronous hot state.
- **Change events** (glob-matched pub/sub) delivered lock-free, so a subscriber
  can re-enter the engine without deadlocking.
- **Zero-copy JSI queries** — results cross to JS as an `ArrayBuffer` the JS side
  reads in place, with lazy views that materialize only the rows you touch.
- **No networking, by design.** You don't own these feeds, so the engine doesn't
  pretend to. Integration is always: `fetch()` → `ingest()` → reconcile → change
  event → re-query → UI. See [docs/INTEGRATIONS.md](./docs/INTEGRATIONS.md).

## What it's not for

- **You own the backend and the schema.** Use a real sync engine, or plain
  SQLite. The reconcile machinery is pure overhead when there's one authority.
- **Relational queries.** No joins, no aggregates, no query language —
  collections keyed by natural key, plus kv.
- **Collaborative editing.** Field-level last-writer-wins discards concurrent
  edits by design; you want CRDTs.
- **Time-series and charting.** This stores current state, not history — a merge
  keeps the newest value and drops the previous one.
- **Small datasets.** Below a few thousand rows, anything works. The value here
  is what happens at 100k.

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
