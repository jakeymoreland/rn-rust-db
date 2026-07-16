import { fastPath, p95, sleep } from './harness';

export type HotPathResult = {
  name: string;
  ops: number;
  totalMs: number;
  avgUsPerOp: number;
  p95UsPerOp: number;
  maxChunkMs: number;
  maxJsGapMs: number;
  note?: string;
};

const CHUNK = 100;

// Times `ops` operations in chunks of 100 with a yield between chunks. Per-op
// numbers derive from chunk timings (per-op performance.now() pairs cost as
// much as a 2 µs op and would dominate the measurement). The yield lets the
// 16 ms interval monitor observe real JS-thread blockage, and flush spikes
// (the synchronous 256-set high-water flush) surface as the max chunk.
async function chunked(
  name: string,
  ops: number,
  op: (i: number) => void,
  note?: string,
): Promise<HotPathResult> {
  let maxGap = 0;
  let last = performance.now();
  const tick = setInterval(() => {
    const now = performance.now();
    maxGap = Math.max(maxGap, now - last);
    last = now;
  }, 16);

  const chunkMs: number[] = [];
  let done = 0;
  while (done < ops) {
    const n = Math.min(CHUNK, ops - done);
    const t0 = performance.now();
    for (let i = 0; i < n; i++) op(done + i);
    chunkMs.push(performance.now() - t0);
    done += n;
    await sleep(0);
  }
  clearInterval(tick);

  const totalMs = chunkMs.reduce((a, b) => a + b, 0);
  return {
    name,
    ops,
    totalMs,
    avgUsPerOp: (totalMs / ops) * 1000,
    p95UsPerOp: (p95(chunkMs) / CHUNK) * 1000,
    maxChunkMs: Math.max(...chunkMs),
    maxJsGapMs: maxGap,
    note,
  };
}

export async function runHotPath(onProgress: (msg: string) => void): Promise<HotPathResult[]> {
  const results: HotPathResult[] = [];
  const push = (r: HotPathResult) => {
    results.push(r);
    onProgress(`${r.name}: ${r.avgUsPerOp.toFixed(2)} µs/op avg, p95 ${r.p95UsPerOp.toFixed(2)} µs`);
  };
  const fp = fastPath();

  onProgress('warmup (1k sets)...');
  for (let i = 0; i < 1000; i++) fp.kvSet(`hp:warm${i % 50}`, 'w');
  await sleep(150); // let the 100 ms write-behind flusher drain the warmup

  onProgress('10k sequential sets (90% unique, 10% repeated keys)...');
  push(
    await chunked('set x10k (mixed keys)', 10_000, (i) => {
      const key = i % 10 === 9 ? `hp:hot${i % 100}` : `hp:k${i}`;
      fp.kvSet(key, `v${i}`);
    }, 'median chunk = cached-op cost; max chunk includes the 256-set high-water flush'),
  );
  await sleep(150);

  onProgress('1k sets, one key (coalescing probe)...');
  push(
    await chunked('set x1k (same key)', 1_000, (i) => {
      fp.kvSet('hp:same', `v${i}`);
    }, 'write-behind queues every set (no coalescing): flush writes 256 upserts of one key'),
  );
  await sleep(150);

  onProgress('5k alternating get/set...');
  push(
    await chunked('get/set x5k (alternating)', 5_000, (i) => {
      if (i % 2 === 0) fp.kvSet(`hp:mix${i % 500}`, `v${i}`);
      else fp.kvGet(`hp:mix${(i - 1) % 500}`);
    }),
  );
  await sleep(150);

  onProgress('10k cached gets...');
  push(
    await chunked('get x10k (warm cache)', 10_000, (i) => {
      fp.kvGet(`hp:mix${i % 500}`);
    }),
  );

  return results;
}

export function renderHotPath(results: HotPathResult[]): string {
  const lines = results.map((r) => {
    const head =
      `${r.name}\n` +
      `  ${r.avgUsPerOp.toFixed(2)} µs/op avg · p95 ${r.p95UsPerOp.toFixed(2)} µs · total ${r.totalMs.toFixed(1)} ms (${r.ops} ops)\n` +
      `  worst 100-op chunk ${r.maxChunkMs.toFixed(2)} ms · worst JS-thread gap ${r.maxJsGapMs.toFixed(1)} ms`;
    return r.note ? `${head}\n  (${r.note})` : head;
  });
  return lines.join('\n');
}
