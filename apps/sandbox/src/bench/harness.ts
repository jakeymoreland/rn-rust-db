import { ingest } from '@rn-experiments/reconcile-engine';

export type FastPath = {
  queryEntriesBuffer(collection: string): ArrayBuffer;
  queryEntriesSchemaBuffer(collection: string, fieldsCsv: string): ArrayBuffer;
  queryEntriesObjects(collection: string): Array<{ key: string; fields: Record<string, string> }>;
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

export async function time(
  name: string,
  iterations: number,
  fn: () => Promise<void> | void,
): Promise<BenchResult> {
  // warmup
  for (let i = 0; i < Math.min(5, iterations); i++) await fn();
  const t0 = performance.now();
  for (let i = 0; i < iterations; i++) await fn();
  const totalMs = performance.now() - t0;
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
