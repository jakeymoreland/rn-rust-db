# rn-rust-db

[![CI](https://github.com/jakeymoreland/rn-rust-db/actions/workflows/ci.yml/badge.svg)](https://github.com/jakeymoreland/rn-rust-db/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

## What it is

An on-device reconciler for React Native. You register each feed, hand it
payloads, and read one row per natural key. The core is Rust and SQLite.
JavaScript does the networking. The engine merges.

It merges **per field**, not per record. A partner feed can be older and still
be the only one carrying `phone`, so `phone` lands and the newer name from your
API does not get wiped. A record with `"_deleted": true`, or a key missing from
a source registered with `snapshot: true`, is a tombstone: the row leaves the
book when that version wins, and a later higher version brings it back.

It does not talk to a server, and it does not own your schema. The loop is
`fetch` → `ingest` → change event → read the merged row.

> **Status: experimental.** Tested, benchmarked, and audited. API is pre-1.0.
> The native static libraries are built locally (or by CI as workflow
> artifacts); they are not in the git tree. See [Roadmap](./ROADMAP.md).

## Why it was built

A real offline app had records arriving from a backend, from the device, from
files, and from partners. The feeds disagree, and the app does not own them, so
it cannot tell them to agree upstream.

The libraries that already exist solve a different problem. PowerSync and Turso
replicate one backend you control. `expo-sqlite` and `op-sqlite` store the rows
you insert and leave the merge to application code. WatermelonDB and RxDB are
local databases with one schema. None of them take several untrusted payloads
and produce one field-level row on the device.

This repo is that missing piece, built as a sandbox first: a Rust store behind
a hand-rolled JSI TurboModule, so the merge, the SQLite write, and the change
event stay off the JavaScript thread, and so the cost of that bridge could be
measured on iOS and Android instead of assumed. The module is
`@rn-experiments/reconcile-engine`.

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

**The ordering rule, exactly:** higher physical time wins, then the logical
counter, then `priority`, then `source_id` (bytewise), then the field value
(bytewise). A tombstone wins an equal version against an update. The order is a
total order, so the same updates converge whichever batch arrives first. Within
one batch, a later row at the same physical time gets a higher logical counter,
so a correction later in the payload still wins. `priority` is a tie-break, not
a trust override.

A source timestamp more than five minutes ahead of the local clock (once that
clock is past 2020) is clamped to that bound. A feed whose clock is a day fast
can no longer sit in the future and win forever. Rows with no timestamp are
stamped from a hybrid logical clock that does not move backwards when the wall
clock does.

> **`timestamp_field: null` is a local stamp, not a source time.** Those rows
> are ordered by when this device accepted them. A stale import with no
> timestamp still reads as "just observed" relative to other untimestamped
> rows. Feeds that carry a real time should set `timestamp_field`.

**Deletes.** A record with `"_deleted": true` is a tombstone. It hides the row
when its version wins, and a later higher version brings the row back. Set
`snapshot: true` on a source whose payload is the full set of keys; keys it
stops sending become tombstones at the batch version, which is how a market
that closes by disappearing actually leaves the book. Tombstones older than
seven days (and never inside the skew window) are compacted. After compaction
an older update can insert the row again, so compact only once feeds have
caught up. `compactTombstones` does it on demand.

## What is in the box

`@rn-experiments/reconcile-engine` is the TurboModule. Under it:

- **SQLite-backed store** with the field-level merge above, keyed by a natural
  key. Higher physical time wins, then the logical counter, then priority, then
  source id, then the field value. A tombstone wins a tie against an update.
- **redis-style kv cache** — memory-first, SQLite write-behind, for hot state
  that is not a reconciled row.
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

## Where it is faster, and where it is not

Same phone, same run, same WAL and `synchronous=NORMAL` as bare `expo-sqlite`.
iPhone 16 Pro, debug dev-client, 2026-08-06. The engine's inserts also parse,
normalize, and field-merge. Full table and method: [BENCHMARKS.md](./BENCHMARKS.md).
`apps/shootout` is the harness; the engine is one contender in it.

| scenario | expo-sqlite | this engine |
|---|---:|---:|
| insert one | 0.854 ms | **0.440 ms** |
| insert 1000 | 0.0376 ms/row | **0.0162 ms/row** |
| read all 10,000 rows into JS objects | **60.9 ms** | 61.7 ms |
| read a 50-row page | 2.84 ms | **1.29 ms** |

Reading every row into objects is Hermes building the objects. The buffer does
not help there. It helps the page you actually paint. A 50-row window over a
10,000-row collection was **3.6 ms** on that phone. Materialising every row was
**245 ms**.

Older numbers in this file claimed a 3–12× win over AsyncStorage, Realm, and
SQLite, and a sub-millisecond kv figure from a simulator. Those were the wrong
comparison or the wrong build. The table above is the one to use.

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
