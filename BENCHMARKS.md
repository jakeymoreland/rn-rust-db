# Turbo Module / Rust Engine Benchmarks

Method: Experiments screen in apps/sandbox. **Every result in this file is a
debug dev-client build** — there is no release-build measurement here, on any
platform. Each section names its own hardware; do not assume a section's device
from a neighbouring one, since the file mixes physical devices and simulators.
Paste "Copy as markdown" output below per platform, and always with the date.

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
- Absolute numbers are indicative; ratios are the signal. The 2026-08-05
  sections are physical devices; the older sections below are simulator or
  emulator and say so in their headings.

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

Both sections below are **physical devices, debug dev-client builds**, captured
2026-08-05. The previous tables here were an iPhone 17 simulator and an Android
emulator recorded 2026-07-16 and never updated — by the time they were replaced
they were ~30 engine commits stale, predating the entire optimization arc this
same file documents further down. Identical work had moved 69.0 -> 29.8 ms.
Treat any number in this file older than its section header with suspicion.

Two scored metrics changed meaning on 2026-08-05 and are not comparable with
anything recorded before then:

- `call-overhead sync`/`async` were timed per iteration with an `await` and two
  `performance.now()` calls **inside** the measured window, which for a
  sub-millisecond op costs more than the op. The same no-op read 0.404 ms/op
  under the old timing and 0.0116 ms/op under a tight loop.
- Query Throughput now scores a 10k rung as well as 100k, so a quick run
  produces a real `/100` instead of `--/20`.

### iOS (iPhone 16 Pro, iOS 26.5.2, debug dev-client) — quick run, 2026-08-05T10:18Z

```
╔══════════════════════════════════╗
║ Benchmark Score                  ║
╠══════════════════════════════════╣
║ Native Calls         15/15 ⭐     ║
║ Write Throughput       17/20     ║
║ Query Throughput       15/20     ║
║ JS Interop              6/10     ║
║ Sync Engine            24/25     ║
║ Reliability          10/10 ⭐     ║
╠══════════════════════════════════╣
║ Current Score         87/100     ║
╚══════════════════════════════════╝
```

Reliability's crash check is an in-process proxy (close/reopen), not a process kill.

| benchmark | iterations | total ms | ms/op |
|---|---:|---:|---:|
| call-overhead sync | 1000 | 4.4 | 0.004 |
| call-overhead async | 1000 | 26.1 | 0.026 |
| toy ingest 10000 rows | 1 | 30.1 | 30.059 |
| toy query 10000 rows: JSON string | 10 | 56.6 | 5.657 |
| toy query 10000 rows: JSI objects | 10 | 104.6 | 10.464 |
| toy query 10000 rows: ArrayBuffer | 10 | 35.3 | 3.533 |
| realistic ingest 1000 rows | 1 | 23.0 | 23.036 |
| realistic query 1000 rows: JSON string | 10 | 54.3 | 5.427 |
| realistic query 1000 rows: JSI objects | 10 | 65.5 | 6.548 |
| realistic query 1000 rows: ArrayBuffer | 10 | 11.5 | 1.154 |
| realistic query 1000 rows: schema buffer -> objects | 10 | 249.1 | 24.907 |
| realistic query page (50 rows @ mid-collection of 1000): schema buffer -> objects | 20 | 58.2 | 2.908 |
| realistic query 1000 rows: entries buffer -> lazy view + 20 rows | 10 | 29.1 | 2.907 |
| realistic ingest 10000 rows | 1 | 128.7 | 128.687 |
| realistic query 10000 rows: JSON string | 5 | 38.3 | 7.653 |
| realistic query 10000 rows: JSI objects | 5 | 202.8 | 40.567 |
| realistic query 10000 rows: ArrayBuffer | 5 | 26.0 | 5.191 |
| realistic query 10000 rows: schema buffer -> objects | 5 | 1258.3 | 251.654 |
| realistic query page (50 rows @ mid-collection of 10000): schema buffer -> objects | 20 | 73.5 | 3.674 |
| realistic query 10000 rows: entries buffer -> lazy view + 20 rows | 5 | 33.7 | 6.732 |
| idle FPS baseline (5 s) | 301 | 5006.2 | 16.668 |
| under-load FPS (4 readers incl. sync JSI + 10k ingests) | 78 | 5220.9 | 56.594 |
| under-load FPS (async readers only + 10k ingests) | 235 | 5071.4 | 16.676 |
| streaming ticks (10 s, 1-20 rows/tick) | 86 | 10031.5 | 1.279 |
| LegendList under fire: naive full re-query per tick (not scored) | 21 | 6221.5 | 427.007 |
| LegendList under fire: patched updates (10 changed rows) | 478 | 7980.0 | 16.681 |
| list shootout: buffer+decode (10k rows) | 3 | 937.1 | 314.432 |
| list shootout: schema-buffer+decode (10k rows) | 3 | 1060.7 | 344.551 |
| list shootout: jsi-objects (10k rows) | 3 | 307.0 | 100.664 |
| list shootout: windowed schema-buffer (50-row page) | 3 | 68.3 | 19.415 |
| list shootout: scan+hgetall (first 100 rows, naive baseline) | 3 | 160.2 | 44.015 |
| cold-start hydrate (close->open->10k rows queryable) | 1 | 387.1 | 387.125 |
| event breakdown: ingest->promise (t1-t0) | 50 | 15.6 | 0.310 |
| event breakdown: event-vs-promise (t2-t1) | 50 | 1.2 | 0.025 |
| event breakdown: ingest->event (t2-t0) | 50 | 16.8 | 0.335 |
| reliability: interrupted transaction | 1 | 641.0 | 641.045 |
| reliability: corrupted payload recovery | 1 | 539.0 | 539.045 |
| reliability: retry idempotency | 1 | 11.8 | 11.769 |
| reliability: reopen integrity | 1 | 553.7 | 553.678 |

- **toy ingest 10000 rows**: ~80 B/record JSON, max JS-thread gap 29 ms
- **realistic ingest 1000 rows**: ~948 B/record JSON, 0.9 MB payload, max JS-thread gap 17 ms
- **realistic ingest 10000 rows**: ~951 B/record JSON, 9.5 MB payload, max JS-thread gap 45 ms
- **idle FPS baseline (5 s)**: 60.1 fps effective, detected 60 Hz (budget 16.67 ms), dropped 1/301 (>1.5x budget), worst gap 29.5 ms
- **under-load FPS (4 readers incl. sync JSI + 10k ingests)**: 14.9 fps effective vs 60 Hz target, dropped 78/78 (>1.5x budget 16.67 ms), worst gap 106.2 ms; 22x 10k ingest under load, median 217 ms each; read latencies under load: scan 163.3 ms med x22, hgetall x100 2530.3 ms med x2, objects 47.8 ms med x77, buffer 6.3 ms med x77 (hgetall op = 100 sequential hgetalls)
- **under-load FPS (async readers only + 10k ingests)**: 46.3 fps effective vs 60 Hz target, dropped 33/235 (>1.5x budget 16.67 ms), worst gap 111.8 ms; 30x 10k ingest under load, median 169 ms each; read latencies under load: scan 168.1 ms med x30, hgetall x100 5.7 ms med x187 (hgetall op = 100 sequential hgetalls)
- **streaming ticks (10 s, 1-20 rows/tick)**: 86 ticks; ingest median 1.20 ms; tick->event median 1.28 ms, p95 1.92 ms (hot-row updates over a 10k-row collection)
- **LegendList under fire: naive full re-query per tick (not scored)**: 3.4 fps effective vs 60 Hz target, dropped 15/21 (>1.5x budget 16.67 ms), worst gap 461.6 ms; 14 update waves, ingest->row-committed median 427.8 ms
- **LegendList under fire: patched updates (10 changed rows)**: 59.9 fps effective vs 60 Hz target, dropped 6/478 (>1.5x budget 16.67 ms), worst gap 27.0 ms; 48 update waves, ingest->row-committed median 6.8 ms
- **list shootout: buffer+decode (10k rows)**: query + LegendList commit, median of 3
- **list shootout: schema-buffer+decode (10k rows)**: query + LegendList commit, median of 3
- **list shootout: jsi-objects (10k rows)**: query + LegendList commit, median of 3
- **list shootout: windowed schema-buffer (50-row page)**: query + LegendList commit, median of 3 (not scored)
- **list shootout: scan+hgetall (first 100 rows, naive baseline)**: query + LegendList commit, median of 3 (not scored)
- **cold-start hydrate (close->open->10k rows queryable)**: 10000 rows readable via ArrayBuffer path after reopen
- **event breakdown: ingest->promise (t1-t0)**: median 0.310 ms, p95 0.446 ms
- **event breakdown: event-vs-promise (t2-t1)**: median 0.025 ms, p95 0.034 ms (negative = event beat promise)
- **event breakdown: ingest->event (t2-t0)**: median 0.335 ms, p95 0.473 ms; async call-overhead baseline this run 0.026 ms/op
- **reliability: interrupted transaction**: PASS — 10000 rows after close-mid-ingest + reopen (must be exactly pre- or post-batch, never partial)
- **reliability: corrupted payload recovery**: PASS — malformed JSON rejected, wrong shape rejected, normal ingest still works
- **reliability: retry idempotency**: PASS — 2nd identical ingest: inserted 0, updated 0, unchanged 0, skipped
- **reliability: reopen integrity**: PASS — 10000 rows before, 10000 after reopen; sampled row intact

### Android (moto g35 5G, Unisoc T760, 3.4 GB RAM, Android 15, debug dev-client)

Full run including the 100k block. A budget device on purpose: the reference
ranges in the Industry comparison are for "iPhone 14+/SD 8 Gen 2+", so this is
the low end of what ships, and several conclusions only appear here.

```
Native Calls  8/15 · Write Throughput 9/20 · Query Throughput 0/20
JS Interop    5/10 · Sync Engine     13/25 · Reliability     10/10
Current Score 45/100
```

| benchmark | ms/op |
|---|---:|
| realistic ingest 1000 rows | 83.5 |
| realistic ingest 10000 rows | 803.3 |
| realistic ingest 100000 rows | 10074.0 |
| realistic query 10000 rows: ArrayBuffer | 30.1 |
| realistic query 100000 rows: ArrayBuffer | 300.3 |
| realistic query page (50 rows @ mid-collection of 100000) | 8.3 |
| cold-start hydrate (close->open->10k queryable) | 882.3 |
| event breakdown: ingest->event | 3.6 |

Real-app list: cold hydrate 60.6 ms; idle scroll 50.5 fps (87/253 dropped);
scroll + live ticks 29.6 fps (196/299); tick -> row painted 135.3 ms median.
Note the **idle** scroll already drops 34% of frames with no engine work at all,
so the engine's contribution is the 34% -> 66% delta, not the whole figure.

100k ingest: 10.07 s, 95.4 MB payload, max JS-thread gap 729 ms. It completed —
the same block OOM-killed the app on a memory-starved emulator (`lowmemorykiller
... min watermark is breached even after kill`), which is why Query Throughput
now has a 10k rung: the 20-point category was unmeasurable on exactly the
hardware where query cost matters.

### Betting-feed scenarios (iPhone 16 Pro, debug dev-client)

The workload the engine is positioned for: a 5,000-selection price book, ~1% of
rows moving per tick, four sources with meaningful priorities. Unlike the CRM
shape, which rewrites every field of every row, this separates ~11 static fields
from ~7 volatile ones — the realistic case.

```
  cold snapshot     5000 selections in 52 ms (516 B/row, 10 us/row), inserted 5000
✓ tick wave         50/5000 moved: 2.54 ms median; changed_keys named 50 rows/tick
  insert vs update  500 inserts 16.0 ms (32 us/row) · 500 7-field updates 10.6 ms
                    (21 us/row) · update/insert 0.66x
✓ desk suspension   status=SUSPENDED, back_price=16.33 — desk owns status,
                    feed still owns price
✓ stale secondary   updated 0, unchanged 10; status still SUSPENDED
  unchanged re-poll 0.83 ms (whole-payload skip)
✗ market close      row still present after ceasing to arrive
```

Three findings here matter more than the timings:

1. **10 us/row for a full snapshot** — inside the industry bare-`INSERT` band
   (12-25 us/row) while doing parse -> normalize -> content-hash -> field-level
   reconcile -> write. The realistic row shape is 4-9x faster per row than the
   CRM shape the other sections use.
2. **update/insert is 0.66x** — updates are *cheaper* than inserts. `ROADMAP.md`
   proposes binary/columnar field storage on the theory that rewriting the whole
   `fields` JSON blob to change one value is the write-path floor. Same batch
   size, same row shape, only insert-vs-update differing: it is not. A B-tree
   insertion into the primary key costs more than an update in place. **That
   migration is not justified by this data.** The remaining write-path lever is
   inbound JSON parse, which is ~48% of a full wave and ~70% of a realistic
   one-row-changed poll, and needs no schema change.
3. **`market close` fails by design.** A market that closes stops arriving from
   the feed; deletes are soft-delete + filter only with no tombstone
   reconciliation, so it stays in the book forever. Feeds signal removal by
   omission and the engine has no way to express it — the top functional gap for
   every feed-driven use case.

These scenarios wipe the database first. Without that, a second run finds the
book already seeded and reads as failure when it is really a dirty DB.

## Industry-comparison findings (2026-07-17, iPhone 16 Pro dev build)

> **Superseded in part.** Re-run on the same device 2026-08-05: 10 of 10
> like-for-like rows now pass, including `10k objects into JS` at 42.3 ms
> (30-50 band), which this section's era reported as a genuine loss. Three rows
> that compared our full pipeline against a bare `INSERT` or a parse-only
> reference are no longer graded at all — a parser benchmark is not a database
> write. Strongest surviving result: a single insert is **0.34 ms against a
> 5-16 ms band** for real offline-first databases doing the same work.

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

> **Still broadly valid, one caveat.** The patched pattern this section measures
> could not be used by a real subscriber until change events carried the changed
> keys (2026-08-05). Before that, a consumer was forced onto the naive re-query
> path measured here at 3.1-3.5 fps.

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

Updated 2026-08-05. Several of these reverse earlier conclusions in this file;
where they do, the reason is stated.

1. **Sync reads are not the safe default — this file used to say they were.**
   The old advice ("sync beats async everywhere ... the JSI sync path is clearly
   the right default") was drawn from uncontended no-op round trips. Under
   concurrent write load on a physical device, four readers including a sync JSI
   reader held **14.5 fps with a 142 ms worst gap**, against **45.1 fps** for the
   identical load with async readers only. Two separate causes, both now fixed
   or understood:
   - Reads used to queue behind writes. The engine held one SQLite connection
     and one exclusive mutex, and `execute()` posted reads and writes to a single
     FIFO worker. A read now uses a second read-only connection (WAL gives it a
     committed snapshot) and pure store reads get their own worker queue.
     `hgetall x100` under write load went **5015 ms -> 5.6 ms**.
   - What remains is not contention but **occupancy**: a sync read runs *on the
     JS thread* for its whole duration. 73 reads x 48.7 ms fills a 5 s window.
     No lock design fixes a 48 ms synchronous read against a 16.67 ms frame
     budget. Use async, or a bounded window.
2. **Marshaling dominates reads, and the windowed path is the only one that
   scales.** Over a 10,000-row collection on an iPhone 16 Pro: a 50-row windowed
   page is **3.6 ms**, one zero-copy buffer read lazily is **7.2 ms**, a JS
   object per row is **39.8 ms**, and full schema materialization is **245 ms**.
   The first is roughly flat as the collection grows; the last two are linear.
   The two unbounded calls are now `@deprecated`.
3. **Updates are cheaper than inserts, so the storage format is not the write
   bottleneck.** Same batch size, same row shape: 500 inserts 32 µs/row, 500
   seven-field updates 21 µs/row — **0.66x**. `ROADMAP.md` proposes binary field
   storage on the theory that rewriting the whole `fields` JSON blob is the write
   floor; it is not, because a B-tree insertion costs more than an update in
   place. The real lever is **inbound JSON parse**: ~48% of a full wave and ~70%
   of a realistic one-row-changed poll, needing no schema change.
4. **The whole-payload skip is dramatic but narrow.** A byte-identical re-poll
   of 1000 rows costs **0.2 ms** against 6.4 ms — it short-circuits before
   parsing. Move one field and it cannot fire, and the engine pays a full parse
   to discover 999 rows are unchanged. For a feed where something always moved,
   the fast path never fires.
5. **Change events carry the keys that changed** (2026-08-05). Before that they
   carried counts only, so a subscriber's only correct reaction was a full
   re-query — measured at **3.1 fps** against **59.9 fps** for patching just the
   rows that moved. The fast pattern existed but only the benchmark could use it,
   because only the benchmark knew which keys it had written.
6. **Change-event delivery is not a platform weakness.** An older reading of this
   file suggested a large Android penalty (0.275 ms vs 6.484 ms). Fresh runs on
   both platforms refute it: the event arrives **0.02 ms after** the ingest
   promise resolves. The cost attributed to the event path was the generic async
   call hop.
7. **Benchmark numbers need a fresh database and honest timing.** Two harness
   defects produced wrong conclusions here: per-iteration `await` inside the
   measured window inflated sub-millisecond metrics ~35x, and reading
   `dead_lettered > 0` scored a whole-payload *skip* as an accepted bad payload,
   producing a spurious reliability failure. Both are fixed; the reliability
   contract is now pinned by Rust tests rather than only by the benchmark.
8. **Low-end Android is a different product.** On a moto g35 (Unisoc T760,
   3.4 GB) the same code marshals 10k objects in 150 ms where an iPhone 16 Pro
   does 42 ms, and the idle scroll baseline drops 34% of frames with no engine
   work at all. Guidance that is merely advisable on flagship hardware
   (windowed reads, async, buffer over objects) is mandatory there.
