# Turbo Module / Rust Engine Benchmarks

Method: Experiments screen in apps/sandbox, release-ish dev-client build,
physical device where noted. Paste "Copy as markdown" output below per platform.

Two run modes: **quick** (default button; skips the 100k block, so
`queryBuffer100kMs`/`storageMaxGapMs` show `--` and the scorecard denominator
shrinks accordingly) and **full** (includes the 100k block — the complete
scored run; expect ~30 s of deliberate JS-thread punishment during it). The
separate **Industry** tab runs an 8-row comparison against indicative
industry-reference ranges for JSI/Rust stacks (bridge roundtrip, kv ops, 1 MB
ingest, SQLite single/bulk insert, 10k-object marshaling, DLQ flush); rows
whose reference measures less work than ours carry a caveat.

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
- `runAll()` now wipes the engine DB (deletes the sqlite file + WAL/SHM and
  reopens) at the start of every run, so "query N rows" really queries N rows.
  Bench collections otherwise persist across runs (content-hash makes
  re-ingests idempotent but rows remain) — before the auto-wipe this was a
  manual step, and skipping it made the 1k query step churn ~75 MB buffers
  against an accumulated 100k-row collection until iOS jetsammed the app.
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

The "under fire" scenario runs twice: a naive window that re-queries and
decodes all 10k rows per tick (informational), and a patched window that
fetches only the ~10 changed rows and patches them into existing state — the
scored pattern (`syncListDroppedFramePct` / `syncListUpdateLatencyMs`). The
benchmark can only do the patched pattern because it knows which keys it just
wrote: **change events carry a BatchSummary (counts) but not the changed
keys**, so a real subscriber is forced into the naive full re-query. Adding
changed keys (or a changed-keys query) to the engine's change events is the
single highest-leverage engine API improvement this suite has surfaced.

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

## Industry-comparison findings (2026-07-17, iPhone 16 Pro dev build)

After the optimization arc (WAL synchronous=NORMAL, cached prepared
statements, write-behind kv cache, schema/windowed/lazy buffer paths,
zero-copy jsi::MutableBuffer handoff, bulk-prefetch reconcile):

1. **Write-behind kv works**: set 4.6 µs / get 2.9 µs, memory-first with
   ~100 ms flush cadence. The remaining gap to a pure hashmap (~2 µs) is the
   JSON command envelope, not storage — visible because the "no-op" ping row
   (7 µs) is now *slower* than set: `get missing` is a permanent cache miss
   that probes SQLite, while set never leaves RAM.
2. **Zero-copy + plain-format lazy view**: 10k-rows-to-a-visible-page went
   53.3 → 13.7 ms. The remainder is the SQLite read itself plus the Hermes
   index walk (no JIT: interpreter-dispatched DataView reads dominate JS-side
   binary work — prefer fewer, larger reads and native-side offsets).
3. **Negative result — bulk-prefetch reconcile didn't move bulk ingest**
   (~46 ms/1k rows). Cached per-row SELECT probes were only a few ms per
   thousand; the true floor is per-touched-row serde parse + re-serialize of
   the fields and field_meta JSON blobs (~2 KB/row). Breaking the 12–25 ms
   bare-INSERT band would need normalized/binary field-meta storage or a
   per-row content-hash short-circuit — a schema redesign, not a tuning knob.
4. **Where the engine genuinely beats the reference**: DLQ writes (~0.07 ms
   vs 5–8 ms band), bridge overhead, and single-row insert lands in-band while
   doing a full parse+normalize+reconcile.

## Profiling the Rust engine

From `packages/reconcile-engine/rust` (macOS, no sudo — uses xctrace):

```bash
cargo flamegraph --release --test ingest_timing -- --nocapture   # bulk-ingest harness
cargo flamegraph --release --test schema_stress -- --nocapture   # query paths
cargo flamegraph --release --unit-test -- reconcile::tests::large_batches_take_the_parallel_path
RECONCILE_PAR_THRESHOLD=0 cargo flamegraph --release --test ingest_timing -- --nocapture  # sequential merge
```

Output: `flamegraph.svg` in the crate dir (rename between runs), plus the raw
`cargo-flamegraph.trace` for Instruments. For denser flames, raise the wave
count in `tests/ingest_timing.rs`. This profiles the engine on the Mac only;
the JSI boundary and Hermes need Xcode Instruments against the running app.

## Boundary shootout findings (2026-07-17, iPhone 16 Pro dev build)

The transport question is settled. At ~1 MB, with all payload prep outside
the timers:

| path | wall | JS-thread cost | engine share |
|---|---:|---:|---|
| pure-conversion probe (no-op call) | 5.4 ms | 5.4 ms | — |
| ingestDirect (string, async) | 17.7 ms | ~5.4 ms (conversion only) | 12.7 ms |
| ingestBufferSync (ArrayBuffer) | 13.4 ms | 13.4 ms (sync by design) | 12.7 ms |
| ingestFile (path only) | 15.0 ms | ~0 ms | 13.9 ms (incl. file read) |

1. **The JSI string tax is exactly 5.4 ms/MB on this device** (probe), and it
   cross-checks: the 3.9 MB bulk ingest showed a 22.1 ms JS gap = 5.7 ms/MB.
   Byte transport costs ~0.7 ms/MB — 8x cheaper. The engine pipeline is a
   constant ~12.7 ms/MB regardless of transport.
2. **Production guidance:** strings are fine below ~1 MB (a one-frame JS cost
   at 120 Hz is the worst case); use the bytes path when data already arrives
   as bytes (fetch arrayBuffer); use ingestFile for anything large — its JS
   cost is a path string.
3. **Bulk update waves are in the bare-INSERT band while reconciling**: 1k-row
   update wave = 11.4 ms engine time (12–25 ms reference). Insert waves cost
   more (first-write SQLite work).
4. **The 5k wave's 52.8 ms commit is the WAL autocheckpoint amortization**
   landing inside one background-thread commit — invisible to the UI (JS gap
   stayed at the string-conversion 22 ms), just bursty in the breakdown.
5. **kv at equilibrium**: 3.4–5.9 µs/op sets sustained with flush spikes of
   1–2.6 ms; coalescing turns 1k hot-key sets into a 0.24 ms flush of 100
   rows. LTO must stay off (bitcode-in-staticlib breaks Apple's linker; see
   Cargo.toml note).

## Real-app list result (2026-07-17, iPhone 16 Pro dev build)

LegendList backed by one zero-copy buffer with lazy row materialization
(only visible rows ever become JS objects), rAF scrolling at 500 px/s,
10-row live updates every 200 ms re-queried through the same path:

- cold hydrate, 10k rows -> painted: **23.8 ms** (median of 5). The RxDB
  offline-DB suite reports 304–1288 ms for "first full render with many
  messages" in-browser.
- idle scroll 5 s: 59.8 fps, 3/300 dropped, worst gap 46 ms.
- scroll + live ticks 10 s: 59.7 fps, **33/608 dropped (5.4%)**, worst 71 ms.
- tick -> row painted: **14.5 ms median, p95 15.3 ms** (47 waves) — vs the
  suite's best-in-class 4–18 ms measured in-browser on small datasets.

The data-binding tier ladder on identical load, all measured on this device:
naive full re-query/re-render ≈ 80% dropped frames; patched row updates in
band; lazy zero-copy backing ≈ 5% dropped while scrolling with live data.
Frame drops were never inherent to data volume — they are a property of the
binding tier, and the engine makes the top tier cheap.

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
