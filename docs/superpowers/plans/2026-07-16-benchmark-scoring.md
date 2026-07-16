# Benchmark Scoring & Realistic Load Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scored benchmark suite (6 categories / 100 pts) with streaming-tick, cold-start-hydrate, FlatList-under-fire, and reliability phases in `apps/sandbox`.

**Architecture:** `src/bench.ts` splits into `src/bench/` modules. Phases write raw numbers into a typed `BenchMetrics` object; a pure `score()` maps metrics → `BenchmarkScore` via log-linear threshold bands; a pure `renderScorecard()` renders the box. FlatList phases talk to a mounted `BenchList` through a module-level driver registry.

**Tech Stack:** React Native 0.86 / Expo 57, TypeScript strict, jest + ts-jest for pure modules, `@rn-experiments/reconcile-engine` API (`openEngine/closeEngine/ingest/registerSource/subscribe/executeRaw(Sync)/redis` + `__reconcileEngine` fast path).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-16-benchmark-scoring-design.md` — bands and category maxes are copied there verbatim; do not invent new thresholds.
- Category maxes: native 15, storage 20, query 20, interop 10, sync 25, reliability 10.
- Query category scores the ArrayBuffer path only, 100k rows: <20→20, <50→15, <100→10, <250→5, ≥250→0.
- `runAll(onProgress)` must stay callable from the `__t16` inspector hook.
- Unmeasured categories render `--/max` and are excluded from `overall.available`.
- A phase that throws marks its metrics unmeasured and the run continues.
- Commit messages: plain, no attribution footers.
- All engine row payloads reuse `realisticRows(n, salt, rev)` (moved to `data.ts`); salts: 100 = under-load (existing), 200 = streaming ticks, 300 = FlatList, 400 = reliability.

---

### Task 1: Jest setup + `score.ts` (pure scoring)

**Files:**
- Create: `apps/sandbox/jest.config.js`
- Modify: `apps/sandbox/package.json` (devDeps + test script)
- Create: `apps/sandbox/src/bench/score.ts`
- Test: `apps/sandbox/src/bench/__tests__/score.test.ts`

**Interfaces:**
- Produces: `MetricId`, `BenchMetrics = Partial<Record<MetricId, number>>`, `CategoryScore = { earned: number; max: number; measured: boolean }`, `BenchmarkScore`, `score(metrics: BenchMetrics): BenchmarkScore`, `metricFrac(value: number, anchors: Anchor[]): number`, `RELIABILITY_POINTS`.

- [ ] **Step 1: jest config + deps**

`apps/sandbox/jest.config.js`:
```js
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/src/**/*.test.ts'],
};
```
`package.json`: add `"test": "jest"` script and devDeps `"jest": "^29.7.0"`, `"ts-jest": "^29.1.0"`, `"@types/jest": "^29.5.0"`. Run `yarn install` at repo root.

- [ ] **Step 2: failing tests**

`score.test.ts` (complete file):
```ts
import { score, metricFrac, ANCHORS, type BenchMetrics } from '../score';

describe('metricFrac', () => {
  const a = ANCHORS.nativeSyncCallMs; // edges 0.05/0.2/1/5, fracs 1, 2/3, 1/3, 0
  it('caps at 1 below first edge', () => expect(metricFrac(0.01, a)).toBe(1));
  it('is 0 at/after last edge', () => expect(metricFrac(5, a)).toBe(0));
  it('hits band fracs at edges', () => expect(metricFrac(0.2, a)).toBeCloseTo(2 / 3));
  it('interpolates log-linearly inside a band', () => {
    const f = metricFrac(0.1, a); // between 0.05 (1) and 0.2 (2/3)
    expect(f).toBeLessThan(1);
    expect(f).toBeGreaterThan(2 / 3);
  });
  it('is monotonically non-increasing', () => {
    let prev = Infinity;
    for (const v of [0.01, 0.05, 0.1, 0.2, 0.5, 1, 3, 5, 50]) {
      const f = metricFrac(v, a);
      expect(f).toBeLessThanOrEqual(prev);
      prev = f;
    }
  });
});

describe('score', () => {
  it('marks empty categories unmeasured and excludes them from available', () => {
    const s = score({ nativeSyncCallMs: 0.01, nativeAsyncCallMs: 0.05, nativeEventLatencyMs: 0.5 });
    expect(s.native).toEqual({ earned: 15, max: 15, measured: true });
    expect(s.query.measured).toBe(false);
    expect(s.overall.available).toBe(15);
    expect(s.overall.earned).toBeCloseTo(15);
  });
  it('scores query bands per spec', () => {
    expect(score({ queryBuffer100kMs: 10 }).query.earned).toBe(20);
    expect(score({ queryBuffer100kMs: 300 }).query.earned).toBe(0);
    expect(score({ queryBuffer100kMs: 50 }).query.earned).toBeCloseTo(15);
  });
  it('averages present metrics only within a category', () => {
    const s = score({ nativeSyncCallMs: 0.01 }); // 1 of 3 native metrics
    expect(s.native.earned).toBe(15);
  });
  it('sums reliability check points', () => {
    const s = score({
      reliabilityInterruptedTxn: 1,
      reliabilityCorruptRecovery: 0,
      reliabilityRetryIdempotent: 1,
      reliabilityReopenIntegrity: 1,
    });
    expect(s.reliability).toEqual({ earned: 8, max: 10, measured: true });
  });
  it('full house = 100/100', () => {
    const m: BenchMetrics = {
      nativeSyncCallMs: 0.01, nativeAsyncCallMs: 0.05, nativeEventLatencyMs: 0.5,
      storageIngestUsPerRow: 10, storageTickIngestMs: 2, storageHydrateMs: 30, storageMaxGapMs: 10,
      queryBuffer100kMs: 15,
      interopObjectsVsBufferRatio: 1.5, interopListCommitMs: 40,
      syncTickEventMedianMs: 2, syncTickEventP95Ms: 10, syncIngestUnderLoadMs: 100,
      syncListDroppedFramePct: 0.5, syncListUpdateLatencyMs: 30,
      reliabilityInterruptedTxn: 1, reliabilityCorruptRecovery: 1,
      reliabilityRetryIdempotent: 1, reliabilityReopenIntegrity: 1,
    };
    const s = score(m);
    expect(s.overall).toEqual({ earned: 100, available: 100 });
  });
});
```

- [ ] **Step 3: run, verify FAIL** — `cd apps/sandbox && yarn test` → module `../score` not found.

- [ ] **Step 4: implement `score.ts`**

```ts
export type Anchor = { edge: number; frac: number };

const RELIABILITY_IDS = [
  'reliabilityInterruptedTxn', 'reliabilityCorruptRecovery',
  'reliabilityRetryIdempotent', 'reliabilityReopenIntegrity',
] as const;
type ReliabilityId = (typeof RELIABILITY_IDS)[number];

export const RELIABILITY_POINTS: Record<ReliabilityId, number> = {
  reliabilityInterruptedTxn: 3,
  reliabilityCorruptRecovery: 2,
  reliabilityRetryIdempotent: 3,
  reliabilityReopenIntegrity: 2,
};

const third = (a: number, b: number, c: number, d: number): Anchor[] => [
  { edge: a, frac: 1 }, { edge: b, frac: 2 / 3 }, { edge: c, frac: 1 / 3 }, { edge: d, frac: 0 },
];

export const ANCHORS = {
  nativeSyncCallMs: third(0.05, 0.2, 1, 5),
  nativeAsyncCallMs: third(0.1, 0.5, 2, 10),
  nativeEventLatencyMs: third(1, 5, 20, 50),
  storageIngestUsPerRow: third(15, 50, 200, 1000),
  storageTickIngestMs: third(5, 16, 50, 150),
  storageHydrateMs: third(50, 200, 1000, 5000),
  storageMaxGapMs: third(17, 50, 200, 1000),
  queryBuffer100kMs: [
    { edge: 20, frac: 1 }, { edge: 50, frac: 0.75 },
    { edge: 100, frac: 0.5 }, { edge: 250, frac: 0.25 },
  ] as Anchor[], // ≥250 → 0 via the ≥-last-edge rule
  interopObjectsVsBufferRatio: third(2, 5, 10, 20),
  interopListCommitMs: third(50, 150, 400, 1000),
  syncTickEventMedianMs: third(5, 16, 50, 150),
  syncTickEventP95Ms: third(16, 50, 150, 500),
  syncIngestUnderLoadMs: third(150, 400, 1500, 5000),
  syncListDroppedFramePct: third(1, 5, 15, 30),
  syncListUpdateLatencyMs: third(50, 150, 400, 1000),
} as const;

export type MetricId = keyof typeof ANCHORS | ReliabilityId;
export type BenchMetrics = Partial<Record<MetricId, number>>;
export type CategoryScore = { earned: number; max: number; measured: boolean };
export type BenchmarkScore = {
  overall: { earned: number; available: number };
  native: CategoryScore; storage: CategoryScore; query: CategoryScore;
  interop: CategoryScore; sync: CategoryScore; reliability: CategoryScore;
};

export function metricFrac(value: number, anchors: Anchor[]): number {
  const first = anchors[0];
  const last = anchors[anchors.length - 1];
  if (value <= first.edge || value <= 0) return first.frac;
  if (value >= last.edge) return 0;
  for (let i = 1; i < anchors.length; i++) {
    const a = anchors[i - 1];
    const b = anchors[i];
    if (value < b.edge) {
      const t = (Math.log(value) - Math.log(a.edge)) / (Math.log(b.edge) - Math.log(a.edge));
      return a.frac + (b.frac - a.frac) * t;
    }
  }
  return 0;
}

const BANDED_CATEGORIES = {
  native: { max: 15, metrics: ['nativeSyncCallMs', 'nativeAsyncCallMs', 'nativeEventLatencyMs'] },
  storage: { max: 20, metrics: ['storageIngestUsPerRow', 'storageTickIngestMs', 'storageHydrateMs', 'storageMaxGapMs'] },
  query: { max: 20, metrics: ['queryBuffer100kMs'] },
  interop: { max: 10, metrics: ['interopObjectsVsBufferRatio', 'interopListCommitMs'] },
  sync: { max: 25, metrics: ['syncTickEventMedianMs', 'syncTickEventP95Ms', 'syncIngestUnderLoadMs', 'syncListDroppedFramePct', 'syncListUpdateLatencyMs'] },
} as const;

export function score(metrics: BenchMetrics): BenchmarkScore {
  const cat = (key: keyof typeof BANDED_CATEGORIES): CategoryScore => {
    const { max, metrics: ids } = BANDED_CATEGORIES[key];
    const fracs = ids
      .filter((id) => metrics[id as MetricId] !== undefined)
      .map((id) => metricFrac(metrics[id as MetricId]!, ANCHORS[id as keyof typeof ANCHORS] as Anchor[]));
    if (fracs.length === 0) return { earned: 0, max, measured: false };
    return { earned: (fracs.reduce((a, b) => a + b, 0) / fracs.length) * max, max, measured: true };
  };
  const relMeasured = RELIABILITY_IDS.some((id) => metrics[id] !== undefined);
  const reliability: CategoryScore = {
    earned: RELIABILITY_IDS.reduce((sum, id) => sum + (metrics[id] ? RELIABILITY_POINTS[id] : 0), 0),
    max: 10,
    measured: relMeasured,
  };
  const cats = {
    native: cat('native'), storage: cat('storage'), query: cat('query'),
    interop: cat('interop'), sync: cat('sync'), reliability,
  };
  const measured = Object.values(cats).filter((c) => c.measured);
  return {
    overall: {
      earned: measured.reduce((s, c) => s + c.earned, 0),
      available: measured.reduce((s, c) => s + c.max, 0),
    },
    ...cats,
  };
}
```

- [ ] **Step 5: run, verify PASS**, commit: `Add benchmark score model with banded log-linear scoring`

---

### Task 2: `decode.ts` — ArrayBuffer entry decoder

**Files:**
- Create: `apps/sandbox/src/bench/decode.ts`
- Test: `apps/sandbox/src/bench/__tests__/decode.test.ts`

**Interfaces:**
- Produces: `Row = { key: string; fields: Record<string, string> }`, `decodeEntriesBuffer(buf: ArrayBuffer): Row[]`.
- Wire format (from `cpp/NativeReconcileEngine.cpp`): LE `[u32 count]([u32 klen][key utf8][u32 jlen][fields-json utf8])*`.

- [ ] **Step 1: failing test** — build a buffer for 2 rows with a DataView + TextEncoder, assert round-trip:
```ts
import { decodeEntriesBuffer } from '../decode';

function encode(rows: Array<{ key: string; fields: Record<string, string> }>): ArrayBuffer {
  const te = new TextEncoder();
  const parts = rows.map((r) => ({ k: te.encode(r.key), j: te.encode(JSON.stringify(r.fields)) }));
  const len = 4 + parts.reduce((s, p) => s + 8 + p.k.length + p.j.length, 0);
  const buf = new ArrayBuffer(len);
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  let off = 0;
  dv.setUint32(off, rows.length, true); off += 4;
  for (const p of parts) {
    dv.setUint32(off, p.k.length, true); off += 4;
    u8.set(p.k, off); off += p.k.length;
    dv.setUint32(off, p.j.length, true); off += 4;
    u8.set(p.j, off); off += p.j.length;
  }
  return buf;
}

it('round-trips rows', () => {
  const rows = [
    { key: 'entry:c:1', fields: { name: 'Ann', city: 'Sydney' } },
    { key: 'entry:c:2', fields: { name: 'Bób', notes: 'ünïcödé' } },
  ];
  expect(decodeEntriesBuffer(encode(rows))).toEqual(rows);
});
it('throws on truncated buffer', () => {
  const buf = encode([{ key: 'k', fields: {} }]).slice(0, 6);
  expect(() => decodeEntriesBuffer(buf)).toThrow();
});
```

- [ ] **Step 2: verify FAIL**, then implement:
```ts
export type Row = { key: string; fields: Record<string, string> };

export function decodeEntriesBuffer(buf: ArrayBuffer): Row[] {
  const dv = new DataView(buf);
  const td = new TextDecoder();
  let off = 0;
  const u32 = (): number => {
    if (off + 4 > buf.byteLength) throw new Error('corrupt entry buffer');
    const v = dv.getUint32(off, true);
    off += 4;
    return v;
  };
  const str = (n: number): string => {
    if (off + n > buf.byteLength) throw new Error('corrupt entry buffer');
    const s = td.decode(new Uint8Array(buf, off, n));
    off += n;
    return s;
  };
  const count = u32();
  const out: Row[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const key = str(u32());
    out[i] = { key, fields: JSON.parse(str(u32())) };
  }
  return out;
}
```

- [ ] **Step 3: verify PASS**, commit: `Add JS decoder for the entry ArrayBuffer wire format`

---

### Task 3: Refactor `bench.ts` → `src/bench/` (no behavior change)

**Files:**
- Create: `apps/sandbox/src/bench/harness.ts`, `apps/sandbox/src/bench/data.ts`, `apps/sandbox/src/bench/phases.ts`
- Delete: `apps/sandbox/src/bench.ts`
- Modify: `apps/sandbox/src/screens/ExperimentsScreen.tsx` (imports only)

**Interfaces:**
- `harness.ts` exports (moved verbatim from bench.ts): `BenchResult`, `time`, `median`, `p95`, `sleep`, `startFrameMonitor`, `frameStats`, `FrameStats`, `ingestWithGapMonitor`, plus `fastPath` and its `FastPath` type.
- `data.ts` exports (moved verbatim): `toyRows`, `realisticRows`, `REALISTIC_SIZES` and the name/seed constants.
- `phases.ts` exports: `runAll`, `toMarkdown` (both moved verbatim; imports updated).

- [ ] **Step 1: mechanical move.** Cut the utility functions/types listed above from `bench.ts` into `harness.ts` and `data.ts` (identical bodies, add `export` where needed); move `runAll` + `toMarkdown` into `phases.ts` importing from `./harness` and `./data`; delete `bench.ts`; update `ExperimentsScreen.tsx` to `import { runAll, toMarkdown, type BenchResult } from '../bench/phases';`.
- [ ] **Step 2: verify** — `npx tsc --noEmit` in `apps/sandbox` passes; `yarn test` still green.
- [ ] **Step 3: commit**: `Split bench.ts into bench/ modules`

---

### Task 4: Metrics plumbing + scorecard markdown

**Files:**
- Create: `apps/sandbox/src/bench/markdown.ts`
- Test: `apps/sandbox/src/bench/__tests__/markdown.test.ts`
- Modify: `apps/sandbox/src/bench/phases.ts`, `apps/sandbox/src/screens/ExperimentsScreen.tsx`

**Interfaces:**
- `markdown.ts` produces: `CATEGORY_LABELS: Record<CategoryKey,string>` (`native`→`Native Calls`, `storage`→`Write Throughput`, `query`→`Query Throughput`, `interop`→`JS Interop`, `sync`→`Sync Engine`, `reliability`→`Reliability`), `renderScorecard(score: BenchmarkScore): string`, `toMarkdown(platform: string, out: RunOutput): string` (moves here from phases.ts).
- `phases.ts` produces: `RunOutput = { results: BenchResult[]; metrics: BenchMetrics; score: BenchmarkScore }`; `runAll(onProgress): Promise<RunOutput>`.

- [ ] **Step 1: failing tests** for `renderScorecard`:
```ts
import { renderScorecard } from '../markdown';
import { score } from '../score';

it('renders measured, starred, and unmeasured rows', () => {
  const card = renderScorecard(score({ nativeSyncCallMs: 0.01, nativeAsyncCallMs: 0.05, nativeEventLatencyMs: 0.5 }));
  expect(card).toContain('Native Calls');
  expect(card).toContain('15/15 ⭐');
  expect(card).toContain('Sync Engine');
  expect(card).toContain('--/25');
  expect(card).toContain('Current Score');
  expect(card).toContain('15/15'); // overall earned/available
});
it('rounds earned to integers for display', () => {
  const card = renderScorecard(score({ queryBuffer100kMs: 50 }));
  expect(card).toContain('15/20');
});
```
- [ ] **Step 2: implement.** `renderScorecard` builds the box:
```ts
import type { BenchmarkScore, CategoryScore } from './score';

export const CATEGORY_LABELS = {
  native: 'Native Calls', storage: 'Write Throughput', query: 'Query Throughput',
  interop: 'JS Interop', sync: 'Sync Engine', reliability: 'Reliability',
} as const;
export type CategoryKey = keyof typeof CATEGORY_LABELS;

export function renderScorecard(s: BenchmarkScore): string {
  const row = (label: string, c: CategoryScore): string => {
    const pts = c.measured ? `${Math.round(c.earned)}/${c.max}` : `--/${c.max}`;
    const star = c.measured && Math.round(c.earned) >= c.max ? ' ⭐' : '';
    return `║ ${label.padEnd(18)}${pts.padStart(7)}${star.padEnd(3)} ║`;
  };
  const border = (l: string, m: string, r: string) => `${l}${'═'.repeat(32)}${r}`;
  return [
    border('╔', '═', '╗'),
    row('Benchmark Score', { earned: 0, max: 0, measured: false }).replace('--/0', '   '),
    border('╠', '═', '╣'),
    ...(Object.keys(CATEGORY_LABELS) as CategoryKey[]).map((k) => row(CATEGORY_LABELS[k], s[k])),
    border('╠', '═', '╣'),
    row('Current Score', { earned: s.overall.earned, max: s.overall.available, measured: true }),
    border('╚', '═', '╝'),
  ].join('\n');
}
```
(Adjust padding until tests pass; tests assert content, not alignment. If the title row hack reads poorly, emit a plain `║ Benchmark Score` line instead — content assertions are what matter.) `toMarkdown(platform, out)` = scorecard in a fenced code block, then the existing results table + notes, plus a footnote line: `Reliability's crash check is an in-process proxy (close/reopen), not a process kill.`
- [ ] **Step 3:** `phases.ts`: `runAll` allocates `const metrics: BenchMetrics = {}` and sets, from existing phases:
  - `metrics.nativeSyncCallMs` / `nativeAsyncCallMs` = the two overhead results' `perOpMs`
  - `metrics.storageIngestUsPerRow` = realistic-10k `ingestMs / 10000 * 1000`
  - `metrics.storageMaxGapMs` = realistic-100k `maxGap`
  - `metrics.queryBuffer100kMs` = realistic-100k ArrayBuffer `perOpMs`
  - `metrics.interopObjectsVsBufferRatio` = realistic-10k objects `perOpMs` / buffer `perOpMs`
  - `metrics.syncIngestUnderLoadMs` = `median(ingestDurations)` from the 4-reader load phase
  - `metrics.nativeEventLatencyMs` = `median(dTotal)` from the event breakdown
  Return `{ results, metrics, score: score(metrics) }`. Wrap each numbered phase body in `try { … } catch (e) { onProgress(\`phase failed: ${e}\`); }`.
- [ ] **Step 4:** `ExperimentsScreen` stores `RunOutput | null`, renders `<Text style={{fontFamily:'monospace',fontSize:12}}>{renderScorecard(out.score)}</Text>` after the run, copy button uses new `toMarkdown(Platform.OS, out)`. Keep `__t16` exposure.
- [ ] **Step 5:** tests green, `tsc --noEmit` green, commit: `Thread typed metrics through runAll and render a scorecard`

---

### Task 5: Streaming ticks phase

**Files:**
- Modify: `apps/sandbox/src/bench/phases.ts`

**Interfaces:**
- Consumes: `ingest`, `subscribe`, `realisticRows(n, 200, rev)`, `median`, `p95`, `sleep`.
- Produces metrics: `storageTickIngestMs`, `syncTickEventMedianMs`, `syncTickEventP95Ms`.

- [ ] **Step 1: implement phase** (runs after the under-load phases). Register source `bench_stream` (collection `bench_stream`, key `id`), seed `ingest('bench_stream', realisticRows(10000, 200))`. Then a 10 s loop, one tick in flight at a time, 100 ms target spacing:
```ts
const TICK_WINDOW_MS = 10_000;
const tickIngest: number[] = [];
const tickEvent: number[] = [];
let evtResolve: ((t: number) => void) | null = null;
const unsub = await subscribe('changes:bench_stream', () => evtResolve?.(performance.now()));
const start = performance.now();
let rev = 1;
while (performance.now() - start < TICK_WINDOW_MS) {
  const nRows = 1 + ((rev * 7) % 20);
  const payload = realisticRows(nRows, 200, rev); // updates existing keys
  const evtP = new Promise<number>((res) => (evtResolve = res));
  const t0 = performance.now();
  await ingest('bench_stream', payload);
  tickIngest.push(performance.now() - t0);
  tickEvent.push((await evtP) - t0);
  rev++;
  await sleep(Math.max(0, 100 - (performance.now() - t0)));
}
unsub();
metrics.storageTickIngestMs = median(tickIngest);
metrics.syncTickEventMedianMs = median(tickEvent);
metrics.syncTickEventP95Ms = p95(tickEvent);
```
Push a `BenchResult` named `streaming ticks (10 s, 1–20 rows/tick)` with `perOpMs = median(tickEvent)` and a note carrying tick count, ingest median, event median/p95.

**Caveat:** `realisticRows(n, 200, rev)` generates the *first n* keys of salt 200 — small ticks always update the same head rows. That is acceptable (hot-row updates are realistic); note it in the result note.
- [ ] **Step 2:** device/simulator run shows the phase completing with plausible numbers; commit: `Add streaming-tick benchmark phase`

---

### Task 6: List bridge + BenchList + both FlatList scenarios

**Files:**
- Create: `apps/sandbox/src/bench/listBridge.ts`, `apps/sandbox/src/bench/BenchList.tsx`
- Modify: `apps/sandbox/src/bench/phases.ts`, `apps/sandbox/src/screens/ExperimentsScreen.tsx`

**Interfaces:**
- `listBridge.ts`:
```ts
import type { Row } from './decode';
export type ListDriver = {
  setRows(rows: Row[]): Promise<void>; // resolves after React commit
  startScroll(): void;                 // constant-velocity loop, wraps at end
  stopScroll(): void;
};
let driver: ListDriver | null = null;
export const registerListDriver = (d: ListDriver | null): void => { driver = d; };
export async function waitForListDriver(timeoutMs: number): Promise<ListDriver | null> {
  const t0 = performance.now();
  while (!driver && performance.now() - t0 < timeoutMs) await new Promise((r) => setTimeout(r, 50));
  return driver;
}
```
- `BenchList.tsx`: default-height-300 `FlatList` of `Row`s rendering key + `first_name`/`company`/`balance`/`updated_at` fields; registers a `ListDriver` on mount (unregisters on unmount). `setRows` stores a resolver and resolves it in a `useEffect` keyed on a version counter incremented with each setRows. `startScroll` runs a 32 ms interval adding 16 px via `scrollToOffset({ animated: false })`, wrapping when past `contentHeight - 300`.
- Produces metrics: `syncListDroppedFramePct`, `syncListUpdateLatencyMs` (scenario A), `interopListCommitMs` (scenario B).

- [ ] **Step 1: implement `listBridge.ts` and `BenchList.tsx`** per interfaces above. `ExperimentsScreen` mounts `<BenchList />` whenever `running` is true (above the progress log).
- [ ] **Step 2: scenario A phase** (`FlatList under fire`), after streaming ticks. Needs `budgetMs`/`refreshHz` from the idle-baseline block — hoist those to `runAll` scope (they already are). Register source `bench_list` (collection `bench_list`, key `id`), seed 10k `realisticRows(10000, 300)`, initial `setRows(decodeEntriesBuffer(fastPath().queryEntriesBuffer('bench_list')))`. Then:
```ts
const drv = await waitForListDriver(3000);
if (!drv) { onProgress('list driver unavailable — skipping FlatList phases'); }
else {
  const updateLatencies: number[] = [];
  let evtResolve: (() => void) | null = null;
  const unsub = await subscribe('changes:bench_list', () => evtResolve?.());
  drv.startScroll();
  const mon = startFrameMonitor();
  const t0 = performance.now();
  let rev = 1;
  while (performance.now() - t0 < 8000) {
    const evtP = new Promise<void>((res) => (evtResolve = res));
    const tw = performance.now();
    await ingest('bench_list', realisticRows(10, 300, rev++));
    await evtP;
    await drv.setRows(decodeEntriesBuffer(fastPath().queryEntriesBuffer('bench_list')));
    updateLatencies.push(performance.now() - tw);
    await sleep(Math.max(0, 150 - (performance.now() - tw)));
  }
  const s = frameStats(mon.stop(), budgetMs);
  drv.stopScroll();
  unsub();
  metrics.syncListDroppedFramePct = (s.dropped / Math.max(1, s.frames)) * 100;
  metrics.syncListUpdateLatencyMs = median(updateLatencies);
  // push a BenchResult with fps/dropped/worst-gap note as in the under-load phases
}
```
- [ ] **Step 3: scenario B phase** (`boundary shootout`), immediately after A (list still mounted, `bench_list` populated). For each strategy — `buffer+decode` = `decodeEntriesBuffer(fastPath().queryEntriesBuffer('bench_list'))`, `jsi-objects` = `fastPath().queryEntriesObjects('bench_list')`, `scan+hgetall(100)` = first 100 keys of `redis.scan('entry:bench_list:*')` each fetched with `redis.hgetall` — run 3 iterations of: `await drv.setRows([])`, `t0`, fetch rows, `await drv.setRows(rows)`, record `now − t0`; take the median per strategy. `metrics.interopListCommitMs = Math.min(medBuffer, medObjects)` (the 100-row naive path is reported in the note but never scored). Push one `BenchResult` per strategy.
- [ ] **Step 4:** `tsc --noEmit` green; on-device run shows scrolling list + plausible numbers; commit: `Add FlatList live-update and boundary-shootout phases`

---

### Task 7: Cold-start hydrate phase + engine path module

**Files:**
- Create: `apps/sandbox/src/enginePath.ts`
- Modify: `apps/sandbox/App.tsx`, `apps/sandbox/src/bench/phases.ts`

**Interfaces:**
- `enginePath.ts`: `setEnginePath(p: string): void`, `getEnginePath(): string` (throws if unset).
- Produces metric: `storageHydrateMs`.

- [ ] **Step 1:** `enginePath.ts` (module-level `let`), `App.tsx` calls `setEnginePath(path)` just before `openEngine(path)`.
- [ ] **Step 2: phase** (runs after the FlatList phases and the event breakdown, before reliability):
```ts
const t0 = performance.now();
closeEngine();
await openEngine(getEnginePath());
let rows = 0;
do { rows = decodeEntriesBuffer(fastPath().queryEntriesBuffer('bench_list')).length; } while (rows < 10000);
metrics.storageHydrateMs = performance.now() - t0;
for (const s of SOURCES) await registerSource(s); // restore the app's fixture sources
```
Push `BenchResult` `cold-start hydrate (close→open→10k rows queryable)`. Import `SOURCES` from `../fixtures`.
- [ ] **Step 3:** device run; commit: `Add cold-start hydrate phase`

---

### Task 8: Reliability checks phase

**Files:**
- Modify: `apps/sandbox/src/bench/phases.ts`

**Interfaces:**
- Consumes: `ingest`, `closeEngine`, `openEngine`, `getEnginePath`, `subscribe`, `redis.scan`, `redis.hgetall`, `realisticRows(n, 400, rev)`, `EngineError`.
- Produces metrics: `reliabilityInterruptedTxn`, `reliabilityCorruptRecovery`, `reliabilityRetryIdempotent`, `reliabilityReopenIntegrity` (each 1 or 0). Every check body is wrapped in try/catch; a throw = 0 for that check, run continues.

- [ ] **Step 1: implement the four checks** against a fresh source `bench_rel` (collection `bench_rel`, key `id`):
  1. **Interrupted transaction (3 pts):** ingest `realisticRows(1000, 400, 0)` fully; start `const p = ingest('bench_rel', realisticRows(10000, 400, 1))` un-awaited; `await sleep(5)`; `closeEngine()`; `await p.catch(() => undefined)`; `await openEngine(getEnginePath())`; re-register `bench_rel`; `const rows = decodeEntriesBuffer(fastPath().queryEntriesBuffer('bench_rel'))`; pass iff `rows.length === 1000 || rows.length === 10000` (never partial). Note in the result that close may block until the batch commits (mutex), making all-B the common pass.
  2. **Corrupted payload (2 pts):** `ingest('bench_rel', 'not-json')` must reject (or return a summary with `dead_lettered > 0`); `ingest('bench_rel', JSON.stringify([{ wrong: 'shape' }]))` must reject or dead-letter; then a normal 10-row ingest + query must succeed. All three conditions → 1.
  3. **Retry idempotency (3 pts):** build one payload `realisticRows(50, 400, 7)`; ingest twice; pass iff second summary has `inserted === 0 && updated === 0` (all `unchanged` or `skipped`).
  4. **Reopen integrity (2 pts):** record `rows.length` and one sampled row's full fields from `bench_rel`; `closeEngine(); await openEngine(getEnginePath())`; re-register; pass iff count and the sampled row's fields deep-equal.
  Push one `BenchResult` per check (`perOpMs` = elapsed ms, note = pass/fail + detail).
- [ ] **Step 2:** device run; commit: `Add reliability checks phase`

---

### Task 9: Scorecard UI polish + docs + full trial

**Files:**
- Modify: `apps/sandbox/src/screens/ExperimentsScreen.tsx`, `BENCHMARKS.md`

- [ ] **Step 1:** ExperimentsScreen scorecard block: monospace scorecard text + per-category worst-metric line (from `metrics` + `ANCHORS`: for each measured banded category show its lowest-frac metric id and value). Simple `<Text>` rows, no styling beyond monospace.
- [ ] **Step 2:** `BENCHMARKS.md`: document the score model (category maxes, band tables copied from the spec), the `--/available` semantics, and the reliability-proxy footnote, under a new `## Scoring` section above `## Results`.
- [ ] **Step 3:** `yarn test` + `tsc --noEmit` green; full run on simulator via `npx expo run:ios` from `apps/sandbox`; paste nothing (user trials on device). Commit: `Render scorecard in Experiments screen and document scoring`

## Self-Review Notes

- Spec coverage: score model (T1), `--` semantics (T1/T4), scorecard box (T4), streaming ticks (T5), FlatList A+B (T6), cold-start hydrate (T7), reliability (T8), UI + docs (T9), error-isolation per phase (T4 step 3), jest (T1/T2/T4). JSON full-row strategy in the shootout is replaced by `scan+hgetall(100)` naive baseline because the engine has no full-row JSON query command — deviation noted in spec terms in the result note and BENCHMARKS.md.
- Types consistent: `Row` from `decode.ts` is reused by `listBridge`/`BenchList`; `RunOutput` produced in T4 consumed by T9 UI; `metricFrac`/`ANCHORS` exported for T9's worst-metric display.
