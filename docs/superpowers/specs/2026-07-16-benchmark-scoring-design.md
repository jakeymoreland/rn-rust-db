# Benchmark Scoring & Realistic Load Design

Date: 2026-07-16
Status: Approved pending final user review
Scope: `apps/sandbox` benchmark suite (`src/bench.ts` → `src/bench/`), Experiments screen.

## Goal

After a benchmark run, print a scorecard that answers "is this engine fast
enough and correct enough for production use on this device?" — absolute,
UX-budget-based scoring (not device-relative), with a few category scores plus
an overall. Add missing realistic load patterns: streaming ticks, cold-start
hydrate, and two FlatList scenarios.

## Score model

100 points across six categories. Scoring is a pure function over a typed
metrics object — no parsing of human-readable result strings.

```ts
type CategoryScore = { earned: number; max: number; measured: boolean };

type BenchmarkScore = {
  overall: { earned: number; available: number }; // available = sum of measured category maxes
  native: CategoryScore;      // 15
  storage: CategoryScore;     // 20
  query: CategoryScore;       // 20
  interop: CategoryScore;     // 10
  sync: CategoryScore;        // 25
  reliability: CategoryScore; // 10
};
```

`measured: false` renders as `--/max` and its max is excluded from
`overall.available` (mock: `Current Score 57/65`). Within a threshold band,
points interpolate log-linearly between band edges so nearby results don't
score identically; band labels stay the legible summary.

### Category metrics and bands

**native — 15 pts**
| metric | full | mid | low | zero |
|---|---|---|---|---|
| sync call overhead (ms/op) | <0.05 → 15 | <0.2 → 10 | <1 → 5 | >5 → 0 |
| async call overhead (ms/op) | <0.1 | <0.5 | <2 | >10 |
| event callback latency, median t2−t0 (ms) | <1 | <5 | <20 | >50 |

Aggregation (all multi-metric categories): earned = equal-weighted mean of
the metric scores (each 0–1) scaled to the category max. Query and
reliability are exceptions: query is a single metric; reliability sums its
per-check points.

**storage (write throughput) — 20 pts**
| metric | bands |
|---|---|
| bulk ingest per-row, 10k realistic (µs/row) | <15 / <50 / <200 / >1000 |
| streaming tick absorb (median tick ingest ms) | <5 / <16 / <50 / >150 |
| cold-start hydrate: open → 10k rows queryable (ms) | <50 / <200 / <1000 / >5000 |
| JS-thread max gap during 100k ingest (ms) | <17 / <50 / <200 / >1000 |

**query — 20 pts** (ArrayBuffer path only — the designated high-performance path)
| 100k rows per-op | points |
|---|---|
| <20 ms | 20 |
| <50 ms | 15 |
| <100 ms | 10 |
| <250 ms | 5 |
| ≥250 ms | 0 |

**interop (JS boundary tax) — 10 pts**
| metric | bands |
|---|---|
| JSI objects vs ArrayBuffer overhead ratio @10k (per-op ratio) | <2× / <5× / <10× / >20× |
| FlatList boundary shootout: best strategy query+commit @10k (ms) | <50 / <150 / <400 / >1000 |

**sync (live pipeline) — 25 pts**
| metric | bands |
|---|---|
| streaming tick → subscribe event, median (ms) | <5 / <16 / <50 / >150 |
| streaming tick → subscribe event, p95 (ms) | <16 / <50 / <150 / >500 |
| 10k ingest-under-load median (ms) | <150 / <400 / <1500 / >5000 |
| FlatList-under-fire: dropped frames while auto-scrolling + ticks (%) | <1 / <5 / <15 / >30 |
| FlatList-under-fire: ingest → row visibly committed, median (ms) | <50 / <150 / <400 / >1000 |

**reliability (correctness under adversity) — 10 pts**, pass/fail checks:
1. Interrupted transaction (3 pts): start a 10k ingest, `close()` mid-flight,
   reopen; collection must be entirely pre-batch or entirely post-batch, never
   partial.
2. Corrupted payload recovery (2 pts): ingest malformed JSON and wrong-shaped
   rows; expect clean errors, then verify normal ingest + query still work.
3. Retry correctness (3 pts): ingest an identical batch twice; row count and
   content unchanged, and no change-events fire for unchanged rows.
4. Crash-adjacent recovery (2 pts): reopen the existing DB and verify prior
   data integrity (row count + spot-check field hashes). True SIGKILL testing
   is not reachable from an in-process JS harness; the scorecard footnotes
   this as a proxy.

## New benchmark phases

- **Streaming ticks**: 10 s of 1–20-row deltas every 50–200 ms into the seeded
  10k collection with a live `subscribe()`. Produces tick ingest medians,
  tick→event median/p95, frame stats during the stream.
- **Cold-start hydrate**: `close()` then `open()`, time from open until 10k
  rows are returned via the ArrayBuffer path. Replaces the hand-run
  `console.time` note in BENCHMARKS.md.
- **List scenario A — live list under fire**: real virtualized list
  (LegendList) of 10k realistic records on its own route during the phase.
  Programmatic auto-scroll while streaming ticks rewrite rows. Runs two
  data-binding patterns: naive (`subscribe()` → full re-query → `setState`,
  informational) and patched (fetch only the changed rows and patch state —
  scored, since it reflects a well-built app). Measures scroll FPS/dropped
  frames and ingest→row-committed latency (commit observed via `useEffect`
  after the data-bearing state lands). Amended 2026-07-16: originally a
  single full-re-query scenario nested in the Experiments screen; split and
  re-routed after device trials showed the naive pattern saturating the JS
  thread (80% dropped frames on a 120 Hz device).
- **FlatList B — boundary shootout**: same list; rows rebound from each read
  path (JSON string / JSI objects / ArrayBuffer) in turn; measures query +
  re-render commit time per strategy.

## Harness changes

- `runAll` returns `{ results: BenchResult[], metrics: BenchMetrics, score: BenchmarkScore }`;
  each phase writes raw numbers into `metrics` (typed, keyed by metric id)
  alongside the existing human-readable `BenchResult` rows.
- `runAll(onProgress)` signature stays compatible with the `__t16` inspector hook.
- Markdown export gains the scorecard at the top (box style below), then the
  existing results table.

```
╠════════════════════════════════════╣
║ Native Calls        15/15 ⭐       ║
║ Write Throughput    16/20          ║
║ Query Throughput    18/20 ⭐       ║
║ JS Interop           8/10          ║
║ Sync Engine         --/25          ║
║ Reliability         --/10          ║
╠════════════════════════════════════╣
║ Current Score       57/65          ║
```

⭐ marks full-point categories. `--` marks unmeasured categories (excluded
from the denominator).

## UI

Experiments screen additions:
- Scorecard block rendered after a run (overall large; six category rows with
  earned/max and the worst-failing metric named per category).
- The benchmark FlatList, fixed height, mounted only during the FlatList
  phases.
- "Copy as markdown" includes scorecard + results.

## File layout

`src/bench.ts` splits into `src/bench/`:
- `harness.ts` — time/median/p95, frame monitor, gap monitor
- `data.ts` — toy + realistic row generators
- `phases.ts` — all benchmark phases incl. the new ones; owns `runAll`
- `score.ts` — metric ids, thresholds, `score(metrics): BenchmarkScore` (pure)
- `markdown.ts` — scorecard + results rendering
- `BenchList.tsx` — the FlatList component and its two scenario drivers

`src/bench.ts` becomes a re-export shim or callers update imports (small app;
update imports directly).

## Testing

- `score.ts` and `markdown.ts` are pure: unit-tested with jest (add jest +
  ts-jest devDeps to `apps/sandbox`, mirroring the reconcile-engine package
  setup).
- Tests cover: band edges, log-linear interpolation inside bands, unmeasured
  categories excluded from `overall.available`, full-run fixture producing a
  stable scorecard, reliability check point arithmetic.
- Benchmark phases themselves are validated by running on device/simulator
  (they are the test).

## Error handling

- A phase that throws marks its category metrics unmeasured (`--`) and the run
  continues; the error is surfaced in the progress log and markdown notes.
- Reliability checks that fail score 0 for their check but never abort the run.

## Out of scope

- CI/regression tracking against stored baselines.
- True process-kill crash testing.
- Android-specific scoring differences (same budgets on both platforms).
