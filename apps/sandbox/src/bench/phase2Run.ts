import { executeRawSync, ingest, registerSource, type IngestTimings } from '@rn-experiments/reconcile-engine';

import { fastPath, ingestWithGapMonitor, sleep } from './harness';
import { realisticRows } from './data';

export type Phase2Result = {
  name: string;
  totalMs: number;
  maxJsGapMs: number;
  allocDeltaMb: number | null;
  note?: string;
};

// Rough memory signal: Hermes' cumulative allocation counter. The delta over
// a test is allocation VOLUME (includes garbage later collected), not
// retained memory — honest for "how much churn did this cause".
function allocatedBytes(): number | null {
  const hi = (globalThis as { HermesInternal?: { getInstrumentedStats?: () => Record<string, number> } })
    .HermesInternal;
  const stats = hi?.getInstrumentedStats?.();
  if (!stats) return null;
  return stats.js_totalAllocatedBytes ?? stats.js_allocatedBytes ?? null;
}

function kvCmd(cmd: string, args: string[]): unknown {
  const resp = JSON.parse(executeRawSync(JSON.stringify({ cmd, args })));
  if (!resp.ok) throw new Error(`${cmd} failed: ${resp.message}`);
  return resp.value;
}

const fmtTimings = (t?: IngestTimings): string =>
  t
    ? `parse ${t.parse_ms.toFixed(1)} + prefetch ${t.prefetch_ms.toFixed(1)} + merge ${t.merge_ms.toFixed(1)} + write ${t.write_ms.toFixed(1)} + commit ${t.commit_ms.toFixed(1)} ms`
    : 'no timings';

export async function runPhase2(onProgress: (msg: string) => void): Promise<Phase2Result[]> {
  const results: Phase2Result[] = [];
  const fp = fastPath();

  const measure = async (name: string, fn: () => Promise<{ maxGap?: number; note?: string; totalMsOverride?: number }>) => {
    const a0 = allocatedBytes();
    const t0 = performance.now();
    const { maxGap, note, totalMsOverride } = await fn();
    const totalMs = totalMsOverride ?? performance.now() - t0;
    const a1 = allocatedBytes();
    const r: Phase2Result = {
      name,
      totalMs,
      maxJsGapMs: maxGap ?? totalMs, // a fully-synchronous test blocks for its whole duration
      allocDeltaMb: a0 !== null && a1 !== null ? (a1 - a0) / 1e6 : null,
      note,
    };
    results.push(r);
    onProgress(`${name}: ${totalMs.toFixed(1)} ms${note ? ` (${note})` : ''}`);
  };

  await registerSource({
    source_id: 'phase2',
    format: 'Json',
    collection: 'phase2',
    natural_key_field: 'id',
    timestamp_field: null,
    priority: 1,
  });

  // 1. bulk insert scaling — BOTH payloads pre-built outside the timed block
  for (const [i, n] of [100, 1000, 5000].entries()) {
    onProgress(`building ${n}-row payloads...`);
    const insertPayload = realisticRows(n, 950 + i);
    const updatePayload = realisticRows(n, 950 + i, 1);
    await measure(`bulk ingest ${n} rows`, async () => {
      const { ingestMs, maxGap } = await ingestWithGapMonitor('phase2', insertPayload);
      const summary = await ingest('phase2', updatePayload);
      return {
        maxGap,
        note: `insert ${ingestMs.toFixed(1)} ms; update wave: ${fmtTimings(summary.timings)}`,
      };
    });
    await sleep(100);
  }

  // 2a. isolated big flush: queue 1k unique sets with auto-flush parked, then
  // time the synchronous flush itself
  onProgress('flush characterization (1k queued sets, one flush)...');
  kvCmd('kvConfig', ['1000000', '1']);
  await measure('flush of 1k queued sets', async () => {
    for (let i = 0; i < 1000; i++) fp.kvSet(`p2:u${i}`, `v${i}`);
    const t0 = performance.now();
    const flushed = kvCmd('kvFlush', []) as number;
    const flushMs = performance.now() - t0;
    return { maxGap: flushMs, note: `${flushed} rows flushed in ${flushMs.toFixed(2)} ms (synchronous = JS-blocking)` };
  });

  // 2b. high-water sweep: same 2048-set workload at different batch sizes
  for (const hw of [64, 256, 512, 1024]) {
    kvCmd('kvConfig', [String(hw), '1']);
    await measure(`2048 sets @ high-water ${hw}`, async () => {
      // chunks timed individually and summed: the yields between them exist
      // for the timer monitor, and setTimeout(0) waits must not count as work
      let maxChunk = 0;
      let workMs = 0;
      for (let c = 0; c < 2048 / 128; c++) {
        const t0 = performance.now();
        for (let i = 0; i < 128; i++) fp.kvSet(`p2:hw${hw}:${c * 128 + i}`, 'v');
        const dt = performance.now() - t0;
        workMs += dt;
        maxChunk = Math.max(maxChunk, dt);
        await sleep(0);
      }
      return {
        maxGap: maxChunk,
        totalMsOverride: workMs,
        note: `worst 128-set chunk ${maxChunk.toFixed(2)} ms (flush spike); ${((workMs / 2048) * 1000).toFixed(2)} µs/op`,
      };
    });
  }

  // 3. coalescing: 1k sets over 100 keys, flushed, with coalescing off vs on
  for (const co of ['0', '1'] as const) {
    kvCmd('kvConfig', ['1000000', co]);
    await measure(`1k sets on 100 keys, coalesce ${co === '1' ? 'ON' : 'OFF'}`, async () => {
      for (let i = 0; i < 1000; i++) fp.kvSet(`p2:co${co}:${i % 100}`, `v${i}`);
      const t0 = performance.now();
      const flushed = kvCmd('kvFlush', []) as number;
      const flushMs = performance.now() - t0;
      return { maxGap: flushMs, note: `${flushed} rows hit SQLite, flush ${flushMs.toFixed(2)} ms` };
    });
  }
  kvCmd('kvConfig', ['256', '1']); // restore defaults

  // 4. ~1MB ingest with the native timing breakdown — payloads pre-built
  onProgress('building 1 MB payloads...');
  const base = Math.floor(performance.now()) % 100000;
  const mbInsert = realisticRows(1300, 960, base);
  const mbUpdate = realisticRows(1300, 960, base + 1);
  await measure('~1 MB ingest (with breakdown)', async () => {
    const { ingestMs, maxGap } = await ingestWithGapMonitor('phase2', mbInsert);
    const summary = await ingest('phase2', mbUpdate);
    return {
      maxGap,
      note: `first ingest ${ingestMs.toFixed(1)} ms; update wave: ${fmtTimings(summary.timings)}; JS gap = boundary string conversion`,
    };
  });

  return results;
}

export function renderPhase2(results: Phase2Result[]): string {
  return results
    .map((r) => {
      const mem = r.allocDeltaMb === null ? 'n/a' : `${r.allocDeltaMb.toFixed(1)} MB alloc`;
      const head = `${r.name}\n  total ${r.totalMs.toFixed(1)} ms · max JS gap ${r.maxJsGapMs.toFixed(1)} ms · ${mem}`;
      return r.note ? `${head}\n  (${r.note})` : head;
    })
    .join('\n');
}
