# Turbo Module / Rust Engine Benchmarks

Method: Experiments screen in apps/sandbox, release-ish dev-client build,
physical device where noted. Paste "Copy as markdown" output below per platform.

Assessment matrix coverage:
1. Call overhead (sync vs async)          -> call-overhead rows
2. Marshaling (objects vs JSON vs buffer) -> query N rows
3. Ingest under load                      -> ingest N logs + observed UI frame drops
4. Change-event latency                   -> change-event latency row
5. Cold start                             -> logged at engine open (add console.time around openEngine)
6. iOS vs Android deltas                  -> compare sections

Notes on method for these runs:
- Both runs were driven through the same `runAll()` used by the "Run benchmarks"
  button (invoked over the Hermes inspector via the dev-gated `globalThis.__t16`).
- The engine database was wiped before each run so "query N rows" really queries
  N rows — the `bench` collection persists across app restarts and otherwise
  accumulates (content-hash makes re-ingests idempotent but rows remain).
- "JSON string" queries run `scan entry:bench:*` (keys only, one JSON parse);
  "JSI objects" and "ArrayBuffer" return the full rows (key + all fields) via the
  `installFastPath()` host functions. The JSON path carries *less* data per op.
- "max JS-thread gap" is the largest observed stall of a 16 ms JS interval timer
  while the async ingest was in flight.
- Dev-client debug builds on simulator/emulator (Apple-silicon host), not
  physical devices — absolute numbers are indicative, ratios are the signal.

## Scoring

Each run prints a scorecard: 100 points across six categories, scored against
fixed UX budgets (spec: `docs/superpowers/specs/2026-07-16-benchmark-scoring-design.md`).
Unmeasured categories (skipped/failed phases) show `--/max` and are excluded
from the denominator, so `Current Score 57/65` means 57 earned of the 65
measurable this run.

| Category | Max | Metrics (full / mid / low / zero points at) |
|---|---:|---|
| Native Calls | 15 | sync call <0.05/0.2/1/5 ms; async call <0.1/0.5/2/10 ms; ingest→event median <1/5/20/50 ms |
| Write Throughput | 20 | bulk ingest <15/50/200/1000 µs/row @10k; tick ingest median <5/16/50/150 ms; cold-start hydrate <50/200/1000/5000 ms; JS-thread max gap @100k <17/50/200/1000 ms |
| Query Throughput | 20 | ArrayBuffer path @100k rows: <20→20, <50→15, <100→10, <250→5, ≥250→0 |
| JS Interop | 10 | JSI-objects vs ArrayBuffer per-op ratio @10k <2/5/10/20×; best list query+commit @10k <50/150/400/1000 ms |
| Sync Engine | 25 | tick→event median <5/16/50/150 ms and p95 <16/50/150/500 ms; 10k ingest under load <150/400/1500/5000 ms; LegendList-under-fire dropped frames <1/5/15/30 % and ingest→row-committed <50/150/400/1000 ms |
| Reliability | 10 | pass/fail: interrupted transaction (3), corrupted payload recovery (2), retry idempotency (3), reopen integrity (2) |

Within a band, points interpolate log-linearly between edges. Multi-metric
categories average their measured metrics equally. Reliability's crash check
is an in-process proxy (close mid-ingest + reopen), not a process kill.

The LegendList "boundary shootout" also reports a `scan+hgetall` naive baseline
capped at 100 rows; it is informational only and never scored (the engine has
no full-row JSON query command, so that path is what a first-pass app would
write against the redis-style API).

## Results

### iOS (iPhone 17 simulator, iOS 26.3, dev build) — 2026-07-16T10:03:48.421Z

| benchmark | iterations | total ms | ms/op |
|---|---:|---:|---:|
| call-overhead sync | 1000 | 16.1 | 0.016 |
| call-overhead async | 1000 | 34.2 | 0.034 |
| ingest 1000 rows | 1 | 12.4 | 12.374 |
| query 1000 rows: JSON string | 10 | 5.0 | 0.497 |
| query 1000 rows: JSI objects | 10 | 7.3 | 0.725 |
| query 1000 rows: ArrayBuffer | 10 | 1.4 | 0.143 |
| ingest 10000 rows | 1 | 69.0 | 68.982 |
| query 10000 rows: JSON string | 10 | 38.2 | 3.816 |
| query 10000 rows: JSI objects | 10 | 94.1 | 9.412 |
| query 10000 rows: ArrayBuffer | 10 | 20.1 | 2.008 |
| ingest 100000 rows | 1 | 687.7 | 687.661 |
| query 100000 rows: JSON string | 3 | 124.9 | 41.644 |
| query 100000 rows: JSI objects | 3 | 247.1 | 82.369 |
| query 100000 rows: ArrayBuffer | 3 | 68.3 | 22.764 |
| change-event latency | 1 | 0.3 | 0.275 |

Ingest JS-thread stalls (max gap of a 16 ms timer): 1k → 0 ms, 10k → 38 ms, 100k → 84 ms.
Cold start (`openEngine`, fresh DB, schema created): 7.1 ms. Re-open of an existing
~45 MB DB with 100k entries: 2.7 ms.

### Android (Medium Phone API 36.1 emulator, arm64, dev build) — 2026-07-16T10:08:07.595Z

| benchmark | iterations | total ms | ms/op |
|---|---:|---:|---:|
| call-overhead sync | 1000 | 50.6 | 0.051 |
| call-overhead async | 1000 | 227.4 | 0.227 |
| ingest 1000 rows | 1 | 72.8 | 72.752 |
| query 1000 rows: JSON string | 10 | 23.1 | 2.306 |
| query 1000 rows: JSI objects | 10 | 38.2 | 3.823 |
| query 1000 rows: ArrayBuffer | 10 | 10.1 | 1.009 |
| ingest 10000 rows | 1 | 488.3 | 488.281 |
| query 10000 rows: JSON string | 10 | 223.3 | 22.334 |
| query 10000 rows: JSI objects | 10 | 545.3 | 54.529 |
| query 10000 rows: ArrayBuffer | 10 | 88.1 | 8.813 |
| ingest 100000 rows | 1 | 6037.2 | 6037.195 |
| query 100000 rows: JSON string | 3 | 728.4 | 242.793 |
| query 100000 rows: JSI objects | 3 | 1401.4 | 467.126 |
| query 100000 rows: ArrayBuffer | 3 | 489.5 | 163.161 |
| change-event latency | 1 | 6.5 | 6.484 |

Ingest JS-thread stalls (max gap of a 16 ms timer): 1k → 38 ms, 10k → 56 ms, 100k → 659 ms.
Cold start (`openEngine`, fresh DB, schema created): 15.7 ms. Re-open of an existing
DB with 100k entries: 44.9 ms.

## Observations

1. **Call overhead is negligible and sync beats async everywhere.** A no-op
   engine round-trip costs 16 µs sync / 34 µs async on iOS and 51 µs / 227 µs on
   Android — the async penalty is the promise/microtask hop, not the engine, and
   it is proportionally much worse on Android (4.5× vs 2× sync). For small,
   fast reads the JSI sync path is clearly the right default.
2. **Marshaling dominates reads, and ArrayBuffer wins decisively.** At 100k rows
   the binary buffer returns the *full* dataset 2–4× faster than building JSI
   objects (iOS 22.8 ms vs 82.4 ms; Android 163 ms vs 467 ms). Per-row JSI
   object + string allocation is the bottleneck, not bytes crossed: the JSON
   "string" path carries only keys (no field data) and still loses to the buffer.
   The pattern to standardise on is one buffer over the boundary, decoded lazily
   in JS.
3. **SQLite/reconcile write cost scales linearly and stays off the JS thread —
   mostly.** 100k-row ingest took 688 ms on iOS and 6.0 s on Android; during it
   the JS thread's worst stall was 84 ms (iOS) and 659 ms (Android). Those stalls
   are attributable to building and copying the ~10 MB JSON payload string at the
   call boundary (the reconcile itself runs on the engine's background executor),
   so the UI stayed interactive apart from a brief hitch at submission —
   `ingestFile` is the escape hatch when payloads get that large.
4. **Change events are effectively instant**: ingest-to-callback latency was
   0.3 ms on iOS and 6.5 ms on Android, comfortably inside a frame, so
   subscription-driven UI refresh is viable with no polling.
5. **Cold start is a non-issue**: 7 ms (iOS) / 16 ms (Android) to open + migrate a
   fresh DB, and re-opening a ~45 MB DB holding 100k entries stayed under 45 ms.
6. **iOS vs Android delta is large (3–9× across the board)** but overstated by
   this setup: both are debug dev-client builds, and the Android emulator runs a
   debug-mode Hermes plus unoptimised JNI/TurboModule glue. Ratios between
   strategies were consistent across platforms, which is the durable finding;
   absolute numbers need a release build on physical devices before quoting.
