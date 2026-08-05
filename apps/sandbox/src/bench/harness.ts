import { ingest } from '@rn-experiments/reconcile-engine';

export type FastPath = {
  queryEntriesBuffer(collection: string): ArrayBuffer;
  queryEntriesSchemaBuffer(collection: string, fieldsCsv: string): ArrayBuffer;
  queryEntriesSchemaBufferRange(collection: string, fieldsCsv: string, limit: number, offset: number): ArrayBuffer;
  queryEntriesObjects(collection: string): Array<{ key: string; fields: Record<string, string> }>;
  kvGet(key: string): string | undefined;
  kvSet(key: string, value: string): boolean;
  /** Benchmark-only: synchronous byte-transport ingest (blocks the JS thread). */
  ingestBufferSync(sourceId: string, payload: ArrayBuffer): string;
};

export function fastPath(): FastPath {
  const fp = (globalThis as unknown as { __reconcileEngine?: FastPath }).__reconcileEngine;
  if (!fp) throw new Error('fast path not installed (call installFastPath first)');
  return fp;
}

export type BenchResult = {
  name: string;
  iterations: number;
  totalMs: number;
  perOpMs: number;
  note?: string;
};

/**
 * Times a *synchronous* op by running the whole batch in one tight loop.
 *
 * `time()` below brackets every single iteration with `performance.now()` and
 * an `await`, which is right for millisecond-scale work but swamps anything
 * sub-millisecond: the `await` costs a microtask hop *inside* the measured
 * window. The same `executeRawSync` no-op measured 0.404 ms/op through `time()`
 * and 0.0116 ms/op through the Industry tab's tight loop on one device — a 35x
 * gap that is entirely harness overhead, and it was feeding the scored
 * `nativeSyncCallMs` metric.
 *
 * No yielding between iterations, so keep the batch short enough not to stall
 * the UI (a 1000-iteration no-op is ~12 ms).
 */
export async function timeTight(
  name: string,
  iterations: number,
  fn: () => void,
): Promise<BenchResult> {
  for (let i = 0; i < Math.min(100, iterations); i++) fn();
  await sleep(0);
  const t0 = performance.now();
  for (let i = 0; i < iterations; i++) fn();
  const totalMs = performance.now() - t0;
  return { name, iterations, totalMs, perOpMs: totalMs / iterations };
}

/**
 * Times an *async* op across the whole batch rather than per iteration, for the
 * same reason as `timeTight`: at sub-millisecond scale the per-iteration
 * `performance.now()` pair is a material share of the result. The promise hop
 * stays inside the window here because for an async call it is the thing being
 * measured.
 */
export async function timeTightAsync(
  name: string,
  iterations: number,
  fn: () => Promise<void>,
): Promise<BenchResult> {
  for (let i = 0; i < Math.min(20, iterations); i++) await fn();
  await sleep(0);
  const t0 = performance.now();
  for (let i = 0; i < iterations; i++) await fn();
  const totalMs = performance.now() - t0;
  return { name, iterations, totalMs, perOpMs: totalMs / iterations };
}

export async function time(
  name: string,
  iterations: number,
  fn: () => Promise<void> | void,
): Promise<BenchResult> {
  // warmup
  for (let i = 0; i < Math.min(5, iterations); i++) {
    await fn();
    await sleep(0);
  }
  // Each iteration is timed individually so the yield between ops (which lets
  // timers fire and the progress UI paint during heavy 100k-row benchmarks)
  // never counts against the measurement.
  let totalMs = 0;
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    await fn();
    totalMs += performance.now() - t0;
    await sleep(0);
  }
  return { name, iterations, totalMs, perOpMs: totalMs / iterations };
}

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function p95(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)];
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function ingestWithGapMonitor(
  sourceId: string,
  payload: string,
): Promise<{ ingestMs: number; maxGap: number }> {
  // Track JS-thread stalls while the async ingest is in flight.
  let maxGap = 0;
  let last = performance.now();
  const tick = setInterval(() => {
    const now = performance.now();
    maxGap = Math.max(maxGap, now - last);
    last = now;
  }, 16);
  const t0 = performance.now();
  await ingest(sourceId, payload);
  const ingestMs = performance.now() - t0;
  clearInterval(tick);
  return { ingestMs, maxGap };
}

// --- rAF frame monitor for the FPS benchmarks ---

export type FrameStats = {
  durationMs: number;
  frames: number;
  effectiveFps: number;
  dropped: number;
  worstGapMs: number;
  medianDeltaMs: number;
  deltas: number[];
};

export function startFrameMonitor(): { stop: () => number[] } {
  const deltas: number[] = [];
  // Baseline is the monitor's start time, so a stall that begins immediately
  // (e.g. a sync read kicked off right after starting the monitor) is captured
  // as a long first delta rather than silently swallowed.
  let last = performance.now();
  let running = true;
  const loop = () => {
    if (!running) return;
    const now = performance.now();
    deltas.push(now - last);
    last = now;
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  return {
    stop: () => {
      running = false;
      return deltas;
    },
  };
}

export function frameStats(deltas: number[], budgetMs: number): FrameStats {
  const durationMs = deltas.reduce((a, b) => a + b, 0);
  return {
    durationMs,
    frames: deltas.length,
    effectiveFps: durationMs > 0 ? (deltas.length / durationMs) * 1000 : 0,
    dropped: deltas.filter((d) => d > budgetMs * 1.5).length,
    worstGapMs: deltas.length ? Math.max(...deltas) : 0,
    medianDeltaMs: deltas.length ? median(deltas) : 0,
    deltas,
  };
}
