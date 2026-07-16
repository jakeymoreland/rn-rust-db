import { executeRaw, executeRawSync, ingest, redis, registerSource, subscribe } from '@rn-experiments/reconcile-engine';

import {
  type BenchResult,
  fastPath,
  frameStats,
  ingestWithGapMonitor,
  median,
  p95,
  sleep,
  startFrameMonitor,
  time,
} from './harness';
import { REALISTIC_SIZES, realisticRows, toyRows } from './data';
import { type BenchMetrics, score } from './score';
import type { RunOutput } from './markdown';
import { decodeEntriesBuffer, type Row } from './decode';
import { waitForListDriver } from './listBridge';

export type { BenchResult };
export type { RunOutput };

export async function runAll(onProgress: (msg: string) => void): Promise<RunOutput> {
  const results: BenchResult[] = [];
  const metrics: BenchMetrics = {};
  const push = async (p: Promise<BenchResult> | BenchResult) => {
    const r = await p;
    results.push(r);
    onProgress(`${r.name}: ${r.perOpMs.toFixed(3)} ms/op${r.note ? ` (${r.note})` : ''}`);
    return r;
  };
  // A failed phase surrenders its metrics (category shows --/max) but the run continues.
  const phase = async (label: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      onProgress(`phase "${label}" failed: ${e}`);
    }
  };

  let asyncOverheadMs = 0;
  let budgetMs = 1000 / 60;
  let refreshHz = 60;

  // 1. call overhead
  await phase('call overhead', async () => {
    const ping = JSON.stringify({ cmd: 'get', args: ['__bench_missing__'] });
    const sync = await push(time('call-overhead sync', 1000, () => void executeRawSync(ping)));
    const async_ = await push(time('call-overhead async', 1000, async () => void (await executeRaw(ping))));
    metrics.nativeSyncCallMs = sync.perOpMs;
    metrics.nativeAsyncCallMs = async_.perOpMs;
    asyncOverheadMs = async_.perOpMs;
  });

  // 2a. toy shape at 10k, kept as an in-run baseline against the realistic shape
  await phase('toy shape', async () => {
    await registerSource({
      source_id: 'bench',
      format: 'Json',
      collection: 'bench',
      natural_key_field: 'email',
      timestamp_field: null,
      priority: 1,
    });
    const payload = toyRows(10000);
    const bytesPerRecord = Math.round(payload.length / 10000);
    onProgress(`ingesting 10k toy rows (~${bytesPerRecord} B/record)...`);
    const { ingestMs, maxGap } = await ingestWithGapMonitor('bench', payload);
    await push({
      name: 'toy ingest 10000 rows',
      iterations: 1,
      totalMs: ingestMs,
      perOpMs: ingestMs,
      note: `~${bytesPerRecord} B/record JSON, max JS-thread gap ${maxGap.toFixed(0)} ms`,
    });
    await push(time('toy query 10000 rows: JSON string', 10, async () => {
      JSON.parse(await executeRaw(JSON.stringify({ cmd: 'scan', args: ['entry:bench:*'] })));
    }));
    await push(time('toy query 10000 rows: JSI objects', 10, () => {
      fastPath().queryEntriesObjects('bench');
    }));
    await push(time('toy query 10000 rows: ArrayBuffer', 10, () => {
      new Uint8Array(fastPath().queryEntriesBuffer('bench'));
    }));
  });

  // 2b. realistic shape: marshaling + ingest at each size
  await phase('realistic shape', async () => {
    await registerSource({
      source_id: 'bench_real',
      format: 'Json',
      collection: 'bench_real',
      natural_key_field: 'id',
      timestamp_field: null,
      priority: 1,
    });
    for (const n of REALISTIC_SIZES) {
      onProgress(`building ${n} realistic rows...`);
      const payload = realisticRows(n);
      const bytesPerRecord = Math.round(payload.length / n);
      onProgress(`ingesting ${n} realistic rows (~${bytesPerRecord} B/record, ${(payload.length / 1e6).toFixed(1)} MB payload)...`);
      const { ingestMs, maxGap } = await ingestWithGapMonitor('bench_real', payload);
      await push({
        name: `realistic ingest ${n} rows`,
        iterations: 1,
        totalMs: ingestMs,
        perOpMs: ingestMs,
        note: `~${bytesPerRecord} B/record JSON, ${(payload.length / 1e6).toFixed(1)} MB payload, max JS-thread gap ${maxGap.toFixed(0)} ms`,
      });
      if (n === 10000) metrics.storageIngestUsPerRow = (ingestMs / n) * 1000;
      if (n === 100000) metrics.storageMaxGapMs = maxGap;

      const iters = n >= 100000 ? 3 : n >= 10000 ? 5 : 10;
      await push(time(`realistic query ${n} rows: JSON string`, iters, async () => {
        JSON.parse(await executeRaw(JSON.stringify({ cmd: 'scan', args: ['entry:bench_real:*'] })));
      }));
      const objects = await push(time(`realistic query ${n} rows: JSI objects`, iters, () => {
        fastPath().queryEntriesObjects('bench_real');
      }));
      const buffer = await push(time(`realistic query ${n} rows: ArrayBuffer`, iters, () => {
        new Uint8Array(fastPath().queryEntriesBuffer('bench_real'));
      }));
      if (n === 10000) metrics.interopObjectsVsBufferRatio = objects.perOpMs / buffer.perOpMs;
      if (n === 100000) metrics.queryBuffer100kMs = buffer.perOpMs;
    }
  });

  // 3. FPS: idle baseline, then latency-under-load (concurrent reads + big ingest)
  await phase('under load', async () => {
    await registerSource({
      source_id: 'bench_load',
      format: 'Json',
      collection: 'bench_load',
      natural_key_field: 'id',
      timestamp_field: null,
      priority: 1,
    });
    onProgress('seeding bench_load with 10k realistic rows...');
    await ingest('bench_load', realisticRows(10000, 100));

    onProgress('idle rAF baseline (5 s)...');
    {
      const mon = startFrameMonitor();
      await sleep(5000);
      const deltas = mon.stop();
      const med = median(deltas);
      refreshHz = med < 12 ? 120 : 60;
      budgetMs = 1000 / refreshHz;
      const s = frameStats(deltas, budgetMs);
      await push({
        name: 'idle FPS baseline (5 s)',
        iterations: s.frames,
        totalMs: s.durationMs,
        perOpMs: s.medianDeltaMs,
        note: `${s.effectiveFps.toFixed(1)} fps effective, detected ${refreshHz} Hz (budget ${budgetMs.toFixed(2)} ms), dropped ${s.dropped}/${s.frames} (>1.5x budget), worst gap ${s.worstGapMs.toFixed(1)} ms`,
      });
    }

    // keys for the hgetall batch reader
    const keys = (await redis.scan('entry:bench_load:*')).slice(0, 100);
    // Payloads are pre-built (as if they arrived from the network) so the FPS
    // window measures the engine + boundary, not JSON.stringify in JS. Each rev
    // rewrites the same 10k keys with changed content: real update writes
    // without growing the collection mid-benchmark.
    onProgress('pre-building load payloads...');
    const payloads = [1, 2, 3].map((rev) => realisticRows(10000, 100, rev));

    type Reader = { name: string; op: () => Promise<void> | void };
    const asyncReaders: Reader[] = [
      {
        name: 'scan',
        op: async () => {
          JSON.parse(await executeRaw(JSON.stringify({ cmd: 'scan', args: ['entry:bench_load:*'] })));
        },
      },
      {
        name: 'hgetall x100',
        op: async () => {
          for (const k of keys) await redis.hgetall(k);
        },
      },
    ];
    const syncReaders: Reader[] = [
      { name: 'objects', op: () => void fastPath().queryEntriesObjects('bench_load') },
      { name: 'buffer', op: () => void new Uint8Array(fastPath().queryEntriesBuffer('bench_load')) },
    ];

    // Sustain the load for at least 5 s (comparable window to the idle
    // baseline): sequential 10k realistic ingest batches while readers loop.
    const MIN_LOAD_MS = 5000;
    const loadPhase = async (label: string, readers: Reader[]): Promise<number[]> => {
      let done = false;
      const lat = new Map<string, number[]>(readers.map((r) => [r.name, []]));
      const mon = startFrameMonitor();
      const t0 = performance.now();
      const ingestDurations: number[] = [];
      const ingestP = (async () => {
        let rev = 0;
        do {
          const t = performance.now();
          await ingest('bench_load', payloads[rev++ % payloads.length]);
          ingestDurations.push(performance.now() - t);
        } while (performance.now() - t0 < MIN_LOAD_MS);
        done = true;
      })();
      await Promise.all([
        ingestP,
        ...readers.map(async (r) => {
          do {
            const t = performance.now();
            await r.op();
            lat.get(r.name)!.push(performance.now() - t);
            await sleep(0); // yield between ops so readers don't monopolise the JS thread
          } while (!done);
        }),
      ]);
      const totalMs = performance.now() - t0;
      const s = frameStats(mon.stop(), budgetMs);
      const readNote = readers
        .map((r) => `${r.name} ${median(lat.get(r.name)!).toFixed(1)} ms med x${lat.get(r.name)!.length}`)
        .join(', ');
      await push({
        name: label,
        iterations: s.frames,
        totalMs,
        perOpMs: s.medianDeltaMs,
        note:
          `${s.effectiveFps.toFixed(1)} fps effective vs ${refreshHz} Hz target, dropped ${s.dropped}/${s.frames} (>1.5x budget ${budgetMs.toFixed(2)} ms), ` +
          `worst gap ${s.worstGapMs.toFixed(1)} ms; ${ingestDurations.length}x 10k ingest under load, median ${median(ingestDurations).toFixed(0)} ms each; ` +
          `read latencies under load: ${readNote} (hgetall op = 100 sequential hgetalls)`,
      });
      return ingestDurations;
    };

    onProgress('under-load: 4 concurrent readers (incl. sync JSI) + 10k ingest batches...');
    const underLoad = await loadPhase('under-load FPS (4 readers incl. sync JSI + 10k ingests)', [
      ...asyncReaders,
      ...syncReaders,
    ]);
    metrics.syncIngestUnderLoadMs = median(underLoad);
    await sleep(500);
    onProgress('under-load control: async-only readers + 10k ingest batches...');
    await loadPhase('under-load FPS (async readers only + 10k ingests)', asyncReaders);
  });

  // 4. streaming ticks: websocket-style small deltas at ~10 Hz for 10 s with a
  // live subscriber. Small ticks always rewrite the head rows of the salt-200
  // batch (hot-row updates), which is a realistic live-feed pattern.
  await phase('streaming ticks', async () => {
    await registerSource({
      source_id: 'bench_stream',
      format: 'Json',
      collection: 'bench_stream',
      natural_key_field: 'id',
      timestamp_field: null,
      priority: 1,
    });
    onProgress('seeding bench_stream with 10k realistic rows...');
    await ingest('bench_stream', realisticRows(10000, 200));
    onProgress('streaming ticks (10 s of 1-20 row deltas @ ~100 ms)...');

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
    await push({
      name: 'streaming ticks (10 s, 1-20 rows/tick)',
      iterations: tickEvent.length,
      totalMs: performance.now() - start,
      perOpMs: median(tickEvent),
      note:
        `${tickEvent.length} ticks; ingest median ${median(tickIngest).toFixed(2)} ms; ` +
        `tick->event median ${median(tickEvent).toFixed(2)} ms, p95 ${p95(tickEvent).toFixed(2)} ms ` +
        `(hot-row updates over a 10k-row collection)`,
    });
  });

  // 5. FlatList scenarios: a real list bound to the engine. A = live list
  // under fire (auto-scroll + tick ingests + subscribe-driven re-render);
  // B = boundary shootout (same list, rows fed from each read path).
  await phase('FlatList scenarios', async () => {
    await registerSource({
      source_id: 'bench_list',
      format: 'Json',
      collection: 'bench_list',
      natural_key_field: 'id',
      timestamp_field: null,
      priority: 1,
    });
    onProgress('seeding bench_list with 10k realistic rows...');
    await ingest('bench_list', realisticRows(10000, 300));

    const drv = await waitForListDriver(3000);
    if (!drv) {
      onProgress('list driver unavailable — skipping FlatList phases');
      return;
    }
    await drv.setRows(decodeEntriesBuffer(fastPath().queryEntriesBuffer('bench_list')));

    // A: live list under fire
    onProgress('FlatList under fire (8 s: auto-scroll + 10-row ticks + re-render)...');
    {
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
      await push({
        name: 'FlatList under fire (scroll + ticks + re-render)',
        iterations: s.frames,
        totalMs: s.durationMs,
        perOpMs: s.medianDeltaMs,
        note:
          `${s.effectiveFps.toFixed(1)} fps effective vs ${refreshHz} Hz target, dropped ${s.dropped}/${s.frames} ` +
          `(>1.5x budget ${budgetMs.toFixed(2)} ms), worst gap ${s.worstGapMs.toFixed(1)} ms; ` +
          `${updateLatencies.length} update waves, ingest->row-committed median ${median(updateLatencies).toFixed(1)} ms`,
      });
    }

    await sleep(500);

    // B: boundary shootout — which read path should back a real list.
    // scan+hgetall is the naive async-JSON path a first-pass app would write;
    // it is capped at 100 rows (a visible page) and excluded from scoring.
    onProgress('FlatList boundary shootout (buffer+decode vs JSI objects vs scan+hgetall)...');
    {
      const strategies: Array<{ name: string; scored: boolean; fetch: () => Promise<Row[]> | Row[] }> = [
        {
          name: 'buffer+decode (10k rows)',
          scored: true,
          fetch: () => decodeEntriesBuffer(fastPath().queryEntriesBuffer('bench_list')),
        },
        {
          name: 'jsi-objects (10k rows)',
          scored: true,
          fetch: () => fastPath().queryEntriesObjects('bench_list'),
        },
        {
          name: 'scan+hgetall (first 100 rows, naive baseline)',
          scored: false,
          fetch: async () => {
            const keys = (await redis.scan('entry:bench_list:*')).slice(0, 100);
            const rows = [];
            for (const k of keys) rows.push({ key: k, fields: await redis.hgetall(k) });
            return rows;
          },
        },
      ];
      const medians: number[] = [];
      for (const strat of strategies) {
        const times: number[] = [];
        for (let i = 0; i < 3; i++) {
          await drv.setRows([]);
          const t0 = performance.now();
          const rows = await strat.fetch();
          await drv.setRows(rows);
          times.push(performance.now() - t0);
        }
        const med = median(times);
        if (strat.scored) medians.push(med);
        await push({
          name: `list shootout: ${strat.name}`,
          iterations: 3,
          totalMs: times.reduce((a, b) => a + b, 0),
          perOpMs: med,
          note: `query + FlatList commit, median of 3${strat.scored ? '' : ' (not scored)'}`,
        });
      }
      metrics.interopListCommitMs = Math.min(...medians);
      // restore the full list for subsequent phases
      await drv.setRows(decodeEntriesBuffer(fastPath().queryEntriesBuffer('bench_list')));
    }
  });

  // 6. change-event latency breakdown: t0 = before ingest() call,
  // t1 = ingest promise resolves, t2 = subscribe callback fires.
  await phase('event breakdown', async () => {
    await registerSource({
      source_id: 'bench_evt',
      format: 'Json',
      collection: 'bench_evt',
      natural_key_field: 'id',
      timestamp_field: null,
      priority: 1,
    });
    onProgress('change-event latency breakdown (50 x 1-row ingest)...');
    let onEvt: ((t: number) => void) | null = null;
    const unsub = await subscribe('changes:bench_evt', () => onEvt?.(performance.now()));
    const dPromise: number[] = []; // t1 - t0
    const dEvtVsPromise: number[] = []; // t2 - t1
    const dTotal: number[] = []; // t2 - t0
    const ITERS = 50;
    for (let i = 0; i < ITERS + 5; i++) {
      const evtP = new Promise<number>((res) => (onEvt = res));
      const t0 = performance.now();
      const t1P = ingest('bench_evt', JSON.stringify([{ id: `evt_${i}`, seq: String(i), v: String(Math.random()) }])).then(
        () => performance.now(),
      );
      const [t1, t2] = await Promise.all([t1P, evtP]);
      if (i >= 5) {
        // first 5 are warmup
        dPromise.push(t1 - t0);
        dEvtVsPromise.push(t2 - t1);
        dTotal.push(t2 - t0);
      }
      await sleep(0);
    }
    unsub();
    metrics.nativeEventLatencyMs = median(dTotal);
    await push({
      name: 'event breakdown: ingest->promise (t1-t0)',
      iterations: ITERS,
      totalMs: dPromise.reduce((a, b) => a + b, 0),
      perOpMs: median(dPromise),
      note: `median ${median(dPromise).toFixed(3)} ms, p95 ${p95(dPromise).toFixed(3)} ms`,
    });
    await push({
      name: 'event breakdown: event-vs-promise (t2-t1)',
      iterations: ITERS,
      totalMs: dEvtVsPromise.reduce((a, b) => a + b, 0),
      perOpMs: median(dEvtVsPromise),
      note: `median ${median(dEvtVsPromise).toFixed(3)} ms, p95 ${p95(dEvtVsPromise).toFixed(3)} ms (negative = event beat promise)`,
    });
    await push({
      name: 'event breakdown: ingest->event (t2-t0)',
      iterations: ITERS,
      totalMs: dTotal.reduce((a, b) => a + b, 0),
      perOpMs: median(dTotal),
      note: `median ${median(dTotal).toFixed(3)} ms, p95 ${p95(dTotal).toFixed(3)} ms; async call-overhead baseline this run ${asyncOverheadMs.toFixed(3)} ms/op`,
    });
  });

  return { results, metrics, score: score(metrics) };
}
