# rn-rust-db

[![CI](https://github.com/jakeymoreland/rn-rust-db/actions/workflows/ci.yml/badge.svg)](https://github.com/jakeymoreland/rn-rust-db/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

## What it is

An on-device reconciler for React Native. You register each feed, hand it
payloads, and read one row per natural key. The core is Rust and SQLite.
JavaScript does the networking. The engine merges.

The shape it is for is a **live book**: thousands of rows, a few fields moving
on each tick, more than one feed, and the screen showing the current row. A
price on a selection is the reference case. The trading desk can suspend a
market without taking the price away from the feed that owns it, because the
merge is per field. A market that closes leaves the book: a delta feed sends
`"_deleted": true`, and a feed that always sends the whole book is registered
with `snapshot: true` so omission is the delete. A tick is not a whole book.
Absence from a tick does not delete the other rows.

It does not talk to a server. The loop is `fetch` → `ingest` → change event →
read the merged row.

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

## The approach

A live book, not a ledger and not a chart.

Betting odds are the case the engine was measured on: about 5,000 selections,
about 1% of them moving per tick, a primary feed, a slower secondary, and a
trading desk that publishes `status` only. On an iPhone 16 Pro that cold
snapshot landed in 52 ms (10 µs/row) and a 50-row tick in 2.5 ms. The desk's
suspension stayed `SUSPENDED` while the feed kept the price. That split is the
product.

Crypto **last price** across a handful of venues is the same shape: one row
per pair, each venue a source, the screen showing the current price. An order
book is not. A book is many levels deep, and this store keeps one value per
field. A trade tape and a balance are not either. The tape is history, and a
merge here drops the previous value. A balance that two writers touch has to
add, not pick a winner. Use a ledger for that.

Contacts from an API and a CSV are the same mechanism with none of the tick
rate. Fine for a demo. Not why the bridge is Rust.

```ts
await registerSource({
  source_id: 'feed_primary', format: 'Json', collection: 'selections',
  natural_key_field: 'selection_id', timestamp_field: 'updated_at', priority: 10,
});
await registerSource({
  source_id: 'trading_desk', format: 'Json', collection: 'selections',
  natural_key_field: 'selection_id', timestamp_field: 'updated_at', priority: 20,
});

await ingest('feed_primary', JSON.stringify([{
  selection_id: '1.2000000-MATCH_ODDS-47000',
  runner_name: 'Arsenal', back_price: 1.92, status: 'ACTIVE',
  updated_at: '2026-08-05T09:00:00Z',
}]));
await ingest('trading_desk', JSON.stringify([{
  selection_id: '1.2000000-MATCH_ODDS-47000',
  status: 'SUSPENDED',
  updated_at: '2026-08-05T09:00:01Z',
}]));
// status is SUSPENDED (desk, higher priority, later time)
// back_price is still 1.92 (the desk did not send a price)
```

Re-sending an unchanged payload costs nothing (whole-payload hash skip, then a
per-row content hash). Rows that do not parse go to a dead-letter queue. The
batch still commits.

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

- **One backend you own.** Use that backend's sync engine, or plain SQLite.
  The merge is overhead when there is a single authority.
- **Order books, trade history, charts, balances.** One value per field, and
  the previous value is dropped. Depth, a tape, and an adding balance need a
  different store.
- **Relational queries.** No joins, no aggregates. A collection keyed by
  natural key, plus a kv for everything else.
- **Collaborative editing.** Last-writer-wins discards the other edit. That
  wants a CRDT.
- **A few hundred quiet rows.** Anything works. The cost that matters here is
  a few thousand live rows with a tick.

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
