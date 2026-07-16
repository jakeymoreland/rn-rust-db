import { executeRaw, executeRawSync, ingest, redis, registerSource, subscribe } from '@rn-experiments/reconcile-engine';

type FastPath = {
  queryEntriesBuffer(collection: string): ArrayBuffer;
  queryEntriesObjects(collection: string): Array<{ key: string; fields: Record<string, string> }>;
};

function fastPath(): FastPath {
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

async function time(name: string, iterations: number, fn: () => Promise<void> | void): Promise<BenchResult> {
  // warmup
  for (let i = 0; i < Math.min(5, iterations); i++) await fn();
  const t0 = performance.now();
  for (let i = 0; i < iterations; i++) await fn();
  const totalMs = performance.now() - t0;
  return { name, iterations, totalMs, perOpMs: totalMs / iterations };
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function p95(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)];
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// --- Toy shape (4 short string fields, ~70 B/record) — kept for comparison ---

function toyRows(n: number): string {
  const rows = Array.from({ length: n }, (_, i) => ({
    email: `user${i}@bench.com`,
    name: `User ${i}`,
    city: i % 2 ? 'Sydney' : 'Perth',
    score: String(i),
  }));
  return JSON.stringify(rows);
}

// --- Realistic shape: ~22 mixed-type fields as they'd come from a CRM-style API,
// ~0.7-0.8 KB of JSON per record (ids/uuids, contact + address + billing fields,
// ISO timestamps, booleans, numeric amounts, a ~300-char notes field). ---

const FIRST = ['Olivia', 'Liam', 'Amelia', 'Noah', 'Isla', 'Jack', 'Charlotte', 'Oliver', 'Mia', 'William', 'Grace', 'Henry', 'Ava', 'Thomas', 'Ruby', 'James', 'Sophie', 'Lucas', 'Zoe', 'Ethan'];
const LAST = ['Nguyen', 'Smith', 'Papadopoulos', 'Chen', 'Williams', 'Singh', 'Brown', 'Kowalski', 'Taylor', 'Ivanova', 'Jones', 'Fernandez', 'Wilson', 'Okafor', 'Anderson', 'Kim', 'White', 'Rossi', 'Martin', 'Schmidt'];
const STREETS = ['George St', 'Collins Ave', 'Hay St', 'King William Rd', 'Elizabeth Dr', 'Flinders Ln', 'Murray Pl', 'Adelaide Tce'];
const CITIES = ['Sydney', 'Melbourne', 'Perth', 'Brisbane', 'Adelaide', 'Hobart', 'Darwin', 'Canberra'];
const STATES = ['NSW', 'VIC', 'WA', 'QLD', 'SA', 'TAS', 'NT', 'ACT'];
const COMPANIES = ['Acme Health Group', 'Southern Cross Logistics', 'Initial Studios', 'Bluegum Financial', 'Harbour Medical Partners', 'Terra Analytics', 'Redback Insurance', 'Coastline Retail Co'];
const TITLES = ['Account Manager', 'Practice Coordinator', 'Finance Analyst', 'Operations Lead', 'Registered Nurse', 'Claims Assessor', 'Sales Director', 'Support Engineer'];
const STATUSES = ['active', 'pending_review', 'churn_risk', 'onboarding', 'suspended'];
const NOTE_SEED =
  'Follow-up scheduled after quarterly account review; customer expressed interest in the premium reporting module and asked about API rate limits, invoice consolidation across the two billing entities, and migration timelines for the legacy portal. ';

function hex(v: number, width: number): string {
  return (v >>> 0).toString(16).padStart(width, '0').slice(-width);
}

// `salt` shifts the natural keys (a different batch of records); `rev` changes
// only the field content for the same keys (an update wave over existing rows).
export function realisticRows(n: number, salt = 0, rev = 0): string {
  const rows = new Array(n);
  for (let i = 0; i < n; i++) {
    const s = i + salt * 1_000_003 + rev * 7_368_787;
    const first = FIRST[i % FIRST.length];
    const last = LAST[(i * 7) % LAST.length];
    const ci = (i * 13) % CITIES.length;
    const created = new Date(1735689600000 + (s % 500) * 86_400_000 + (s % 86_400) * 1000).toISOString();
    const updated = new Date(1750000000000 + (s % 200) * 3_600_000).toISOString();
    rows[i] = {
      id: `rec_${salt}_${String(i).padStart(7, '0')}`,
      uuid: `${hex(s * 2654435761, 8)}-${hex(s * 40503, 4)}-4${hex(s * 2246822519, 3)}-9${hex(s * 3266489917, 3)}-${hex(s * 668265263, 8)}${hex(s * 374761393, 4)}`,
      first_name: first,
      last_name: last,
      email: `${first.toLowerCase()}.${last.toLowerCase()}${i}@example${i % 9}.com.au`,
      phone: `+61 4${String(10_000_000 + ((s * 97) % 89_999_999)).slice(0, 8)}`,
      address_line1: `${(s % 380) + 1} ${STREETS[(i * 3) % STREETS.length]}`,
      address_city: CITIES[ci],
      address_state: STATES[ci],
      address_postcode: String(2000 + ((s * 31) % 6999)),
      billing_city: CITIES[(ci + 3) % CITIES.length],
      billing_postcode: String(2000 + ((s * 53) % 6999)),
      company: COMPANIES[(i * 5) % COMPANIES.length],
      job_title: TITLES[(i * 11) % TITLES.length],
      status: STATUSES[i % STATUSES.length],
      is_active: i % 7 !== 0,
      email_verified: i % 3 !== 0,
      balance: Math.round(((s * 137) % 2_500_000)) / 100,
      lifetime_value: Math.round(((s * 631) % 90_000_000)) / 100,
      currency: 'AUD',
      created_at: created,
      updated_at: updated,
      notes: `[case ${hex(s * 2654435761, 6)}] ${NOTE_SEED}${NOTE_SEED.slice(0, 60 + (i % 40))}`,
    };
  }
  return JSON.stringify(rows);
}

// If 100k realistic rows (~75 MB JSON) proves too slow / OOMs on the Android
// emulator, drop this to [1000, 10000, 50000] and note it in BENCHMARKS.md.
const REALISTIC_SIZES = [1000, 10000, 100000];

async function ingestWithGapMonitor(sourceId: string, payload: string): Promise<{ ingestMs: number; maxGap: number }> {
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

type FrameStats = {
  durationMs: number;
  frames: number;
  effectiveFps: number;
  dropped: number;
  worstGapMs: number;
  medianDeltaMs: number;
  deltas: number[];
};

function startFrameMonitor(): { stop: () => number[] } {
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

function frameStats(deltas: number[], budgetMs: number): FrameStats {
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

export async function runAll(onProgress: (msg: string) => void): Promise<BenchResult[]> {
  const results: BenchResult[] = [];
  const push = async (p: Promise<BenchResult> | BenchResult) => {
    const r = await p;
    results.push(r);
    onProgress(`${r.name}: ${r.perOpMs.toFixed(3)} ms/op${r.note ? ` (${r.note})` : ''}`);
    return r;
  };

  // 1. call overhead
  const ping = JSON.stringify({ cmd: 'get', args: ['__bench_missing__'] });
  await push(time('call-overhead sync', 1000, () => void executeRawSync(ping)));
  const asyncOverhead = await push(time('call-overhead async', 1000, async () => void (await executeRaw(ping))));

  // 2a. toy shape at 10k, kept as an in-run baseline against the realistic shape
  await registerSource({
    source_id: 'bench',
    format: 'Json',
    collection: 'bench',
    natural_key_field: 'email',
    timestamp_field: null,
    priority: 1,
  });
  {
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
  }

  // 2b. realistic shape: marshaling + ingest at each size
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

    const iters = n >= 100000 ? 3 : n >= 10000 ? 5 : 10;
    await push(time(`realistic query ${n} rows: JSON string`, iters, async () => {
      JSON.parse(await executeRaw(JSON.stringify({ cmd: 'scan', args: ['entry:bench_real:*'] })));
    }));
    await push(time(`realistic query ${n} rows: JSI objects`, iters, () => {
      fastPath().queryEntriesObjects('bench_real');
    }));
    await push(time(`realistic query ${n} rows: ArrayBuffer`, iters, () => {
      new Uint8Array(fastPath().queryEntriesBuffer('bench_real'));
    }));
  }

  // 3. FPS: idle baseline, then latency-under-load (concurrent reads + big ingest)
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
  let budgetMs: number;
  let refreshHz: number;
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

  {
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
    const loadPhase = async (label: string, readers: Reader[]) => {
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
    };

    onProgress('under-load: 4 concurrent readers (incl. sync JSI) + 10k ingest batches...');
    await loadPhase('under-load FPS (4 readers incl. sync JSI + 10k ingests)', [...asyncReaders, ...syncReaders]);
    await sleep(500);
    onProgress('under-load control: async-only readers + 10k ingest batches...');
    await loadPhase('under-load FPS (async readers only + 10k ingests)', asyncReaders);
  }

  // 4. change-event latency breakdown: t0 = before ingest() call,
  // t1 = ingest promise resolves, t2 = subscribe callback fires.
  {
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
      note: `median ${median(dTotal).toFixed(3)} ms, p95 ${p95(dTotal).toFixed(3)} ms; async call-overhead baseline this run ${asyncOverhead.perOpMs.toFixed(3)} ms/op`,
    });
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
    ...results.filter((r) => r.note).map((r) => `- **${r.name}**: ${r.note}`),
    '',
  ];
  return lines.join('\n');
}
