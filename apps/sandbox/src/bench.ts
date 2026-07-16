import { executeRaw, executeRawSync, ingest, registerSource, subscribe } from '@rn-experiments/reconcile-engine';

type FastPath = {
  queryEntriesBuffer(collection: string): ArrayBuffer;
  queryEntriesObjects(collection: string): Array<{ key: string; fields: Record<string, string> }>;
};

function fastPath(): FastPath {
  const fp = (globalThis as unknown as { __reconcileEngine?: FastPath }).__reconcileEngine;
  if (!fp) throw new Error('fast path not installed (call installFastPath first)');
  return fp;
}

export type BenchResult = { name: string; iterations: number; totalMs: number; perOpMs: number };

async function time(name: string, iterations: number, fn: () => Promise<void> | void): Promise<BenchResult> {
  // warmup
  for (let i = 0; i < Math.min(5, iterations); i++) await fn();
  const t0 = performance.now();
  for (let i = 0; i < iterations; i++) await fn();
  const totalMs = performance.now() - t0;
  return { name, iterations, totalMs, perOpMs: totalMs / iterations };
}

function benchRows(n: number): string {
  const rows = Array.from({ length: n }, (_, i) => ({
    email: `user${i}@bench.com`,
    name: `User ${i}`,
    city: i % 2 ? 'Sydney' : 'Perth',
    score: String(i),
  }));
  return JSON.stringify(rows);
}

export async function runAll(onProgress: (msg: string) => void): Promise<BenchResult[]> {
  const results: BenchResult[] = [];
  const push = async (p: Promise<BenchResult>) => {
    const r = await p;
    results.push(r);
    onProgress(`${r.name}: ${r.perOpMs.toFixed(3)} ms/op`);
  };

  // 1. call overhead
  const ping = JSON.stringify({ cmd: 'get', args: ['__bench_missing__'] });
  await push(time('call-overhead sync', 1000, () => void executeRawSync(ping)));
  await push(time('call-overhead async', 1000, async () => void (await executeRaw(ping))));

  // 2. marshaling at sizes
  await registerSource({
    source_id: 'bench',
    format: 'Json',
    collection: 'bench',
    natural_key_field: 'email',
    timestamp_field: null,
    priority: 1,
  });
  for (const n of [1000, 10000, 100000]) {
    onProgress(`ingesting ${n} rows...`);
    // Track JS-thread stalls while the async ingest is in flight (matrix item 3).
    let maxGap = 0;
    let last = performance.now();
    const tick = setInterval(() => {
      const now = performance.now();
      maxGap = Math.max(maxGap, now - last);
      last = now;
    }, 16);
    const t0 = performance.now();
    await ingest('bench', benchRows(n));
    const ingestMs = performance.now() - t0;
    clearInterval(tick);
    results.push({ name: `ingest ${n} rows`, iterations: 1, totalMs: ingestMs, perOpMs: ingestMs });
    onProgress(`ingest ${n}: ${ingestMs.toFixed(0)} ms (max JS-thread gap ${maxGap.toFixed(0)} ms)`);

    const iters = n >= 100000 ? 3 : 10;
    await push(time(`query ${n} rows: JSON string`, iters, async () => {
      const resp = await executeRaw(JSON.stringify({ cmd: 'scan', args: ['entry:bench:*'] }));
      JSON.parse(resp);
    }));
    await push(time(`query ${n} rows: JSI objects`, iters, () => {
      fastPath().queryEntriesObjects('bench');
    }));
    await push(time(`query ${n} rows: ArrayBuffer`, iters, () => {
      const buf = fastPath().queryEntriesBuffer('bench');
      new Uint8Array(buf); // touch it
    }));
  }

  // 3. change-event latency
  {
    let resolveEvt!: (t: number) => void;
    const evt = new Promise<number>((res) => (resolveEvt = res));
    const unsub = await subscribe('changes:bench', () => resolveEvt(performance.now()));
    const t0 = performance.now();
    await ingest('bench', JSON.stringify([{ email: 'evt@bench.com', name: 'Evt', v: String(Math.random()) }]));
    const tEvt = await evt;
    unsub();
    results.push({ name: 'change-event latency', iterations: 1, totalMs: tEvt - t0, perOpMs: tEvt - t0 });
    onProgress(`change-event latency: ${(tEvt - t0).toFixed(1)} ms`);
  }

  return results;
}

export function toMarkdown(platform: string, results: BenchResult[]): string {
  const lines = [
    `### ${platform} — ${new Date().toISOString()}`,
    '',
    '| benchmark | iterations | total ms | ms/op |',
    '|---|---:|---:|---:|',
    ...results.map((r) => `| ${r.name} | ${r.iterations} | ${r.totalMs.toFixed(1)} | ${r.perOpMs.toFixed(3)} |`),
    '',
  ];
  return lines.join('\n');
}
