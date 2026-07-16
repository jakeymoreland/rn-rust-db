# Rust Reconcile Engine — Turbo Module Experiment

**Date:** 2026-07-16
**Status:** Approved
**Goal:** De-risk a real app's offline-first architecture: a Rust-owned SQLite store behind a React Native Turbo Module that normalizes and merges data from multiple sources (backend APIs, device data, files, third-party integrations) into one consistent local store. Deliverables are (1) a working sandbox and (2) an assessment of data flow, marshaling, threading, and caching on iOS and Android.

## Decisions

| Decision | Choice |
|---|---|
| Native core | Rust, exposed as a Turbo Module |
| Bridge | uniffi-bindgen-react-native (generated Turbo Module), plus one hand-rolled C++ JSI ArrayBuffer fast-path as a marshaling benchmark |
| Database | Rust owns SQLite via rusqlite (WAL mode); JS talks only to the engine API |
| Sandbox app | Expo + expo-dev-client |
| Domain | Generic "entries" (id, source, natural key, typed fields, timestamps); device-data specifics intentionally out of scope |
| Public JS API | Redis-esque command surface (see below); reconcile remains the engine's core job |

## Ecosystem context

No existing OSS library does multi-source normalize-and-merge into a local store. PowerSync and Turso embedded replicas solve single-backend sync; op-sqlite / nitro-sqlite / expo-sqlite are JS-owns-DB designs. uniffi-bindgen-react-native (v0.31.x, actively maintained, WASM output emerging) generates the full Turbo Module — C++ JSI glue, TS types, build wiring — from `#[uniffi::export]` Rust. Their patterns (WAL, change streams, write queues) inform the engine; none are dependencies.

## Architecture

```
rn/
├── packages/reconcile-engine/     # the OSS-shaped library
│   ├── rust/                      # Rust crate
│   │   └── src/
│   │       ├── ingest.rs          # per-source payload intake
│   │       ├── normalize.rs       # parsers → canonical records
│   │       ├── reconcile.rs       # merge policies, conflict resolution
│   │       ├── store.rs           # rusqlite (WAL), migrations
│   │       └── api.rs             # #[uniffi::export] surface
│   ├── cpp/fastpath/              # hand-rolled JSI ArrayBuffer query path
│   └── src/                       # generated TS bindings + thin public API
└── apps/sandbox/                  # Expo + dev-client app
```

- Sources implement a Rust `SourceAdapter` trait: parse raw payload → `Vec<CanonicalRecord>`.
- Sandbox mocks three sources: fake REST API (JSON), CSV file import, timer-driven "device" source.
- Reconciler: per-field merge policy (source priority + last-writer-wins), dedupe on natural key, one SQLite transaction per batch.

## Public API: Redis-esque commands

The engine's JS surface is a familiar Redis-style command set rather than a bespoke ORM. Records are hashes; collections are keyspaces; change events are pub/sub.

- **Keyspace layout:** `entry:{collection}:{id}` (record hash), `idx:{collection}` (sorted id set), `meta:{source}` (cursor/etag hash).
- **Reads:** `get`, `hget`, `hgetall`, `scan(pattern)`, `mget`.
- **Writes:** `set`, `hset`, `del` — for JS-side/local data. Reconciled data is written only by `ingest`; direct writes to `entry:*` keys owned by the reconciler are rejected.
- **Pub/sub:** `subscribe(channel)` / `psubscribe(pattern)`; the reconciler publishes to `changes:{collection}` after each commit batch. This IS the change-event system.
- **TTL:** `expire`/`ttl` on cache keys (e.g. memoized derived values, raw payload caches). Reconciled entries are durable and never expire.
- **Ingest (the non-Redis part):** `ingest(sourceId, payload)` / `ingestFile(sourceId, path)` — the reconcile pipeline, async, returns a batch summary.

## Data flow

`JS fetch/file-pick → engine.ingest(sourceId, payload) → parse+reconcile+commit on Rust thread → change event (uniffi callback → JS emitter) → hooks re-query → UI`

- Network stays in JS (auth/retries live there in the real app); JS passes raw strings/bytes.
- Files are passed by path; Rust reads and parses off the JS thread.
- Async engine calls surface as JS promises. Change events are pub/sub messages on `changes:{collection}` channels.
- Queries run two ways for comparison: uniffi typed records vs C++ JSI ArrayBuffer fast-path.

## Caching

1. **Source cursors (Rust):** `sync_meta` table with per-source etags/cursors/timestamps; ingest is incremental and idempotent (content-hash dedupe).
2. **Engine:** no result cache initially — SQLite/WAL is the cache; add a Rust LRU only if measurements justify it.
3. **JS:** hooks re-fetch only when a pub/sub message arrives on their collection's channel (event-driven invalidation). TTL keys handle expiring derived/cache values in the engine itself.

## Assessment matrix (primary deliverable)

An Experiments screen in the sandbox runs these and records results to `BENCHMARKS.md`:

1. Call overhead — sync vs async JS→Rust round-trip
2. Marshaling — uniffi records vs JSON string vs ArrayBuffer at 1k/10k/100k rows
3. Ingest under load — UI frame rate during 100k-row CSV parse/reconcile
4. Change-event latency — commit → hook update
5. Cold start — engine init + migrations
6. iOS vs Android deltas on all of the above

## Error handling

- uniffi error enum (`ParseError`, `StorageError`, `SourceError`) → typed JS exceptions.
- Bad records within a batch are quarantined to a `dead_letter` table; the batch still commits.

## Testing

- `cargo test` covers normalize/reconcile/store logic (where the complexity lives; fast, no device).
- App-level behavior exercised by the Experiments screen on both platforms.
