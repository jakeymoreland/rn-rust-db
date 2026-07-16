import { executeRawSync, ingest, registerSource } from '@rn-experiments/reconcile-engine';

import { fastPath, median, sleep } from './harness';
import { realisticRows } from './data';
import { createLazyEntryRows } from './decode';
import { INDUSTRY_REFS, type IndustryResult } from './industryRefs';

const ref = (key: string) => {
  const r = INDUSTRY_REFS.find((x) => x.key === key);
  if (!r) throw new Error(`no industry ref ${key}`);
  return r;
};

async function timed(iterations: number, fn: () => Promise<void> | void): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    await fn();
    out.push(performance.now() - t0);
    await sleep(0);
  }
  return out;
}

// Runs the industry-reference comparison. ~10 s total; every operation is the
// closest thing this engine has to the reference row (caveats live on the
// refs). Uses salt 900 so it never collides with the main suite's data.
export async function runIndustry(onProgress: (msg: string) => void): Promise<IndustryResult[]> {
  const results: IndustryResult[] = [];
  const done = (key: string, oursMs: number) => {
    const r = { ref: ref(key), oursMs };
    results.push(r);
    onProgress(`${r.ref.component}: ${r.ref.operation} -> ${oursMs.toFixed(3)} ms`);
  };

  await registerSource({
    source_id: 'industry',
    format: 'Json',
    collection: 'industry',
    natural_key_field: 'id',
    timestamp_field: null,
    priority: 1,
  });

  onProgress('JSI roundtrips (1000 sync no-ops)...');
  {
    const ping = JSON.stringify({ cmd: 'get', args: ['__industry_missing__'] });
    for (let i = 0; i < 100; i++) executeRawSync(ping); // warmup
    const t0 = performance.now();
    for (let i = 0; i < 1000; i++) executeRawSync(ping);
    done('jsiRoundtrip', (performance.now() - t0) / 1000);
  }

  onProgress('redis-style set/get (500 sync fast-path ops each)...');
  {
    // dedicated JSI host functions — no JSON command envelope
    const t0 = performance.now();
    for (let i = 0; i < 500; i++) {
      fastPath().kvSet(`industry:kv:${i % 50}`, `v${i}`);
    }
    done('kvWrite', (performance.now() - t0) / 500);
    const t1 = performance.now();
    for (let i = 0; i < 500; i++) {
      fastPath().kvGet(`industry:kv:${i % 50}`);
    }
    done('kvRead', (performance.now() - t1) / 500);
  }

  onProgress('~1 MB JSON ingest (3 update waves)...');
  {
    // ~1300 realistic rows ≈ 1 MB; a fresh rev each wave forces real updates
    // instead of content-hash skips. Payloads are PRE-BUILT: generating rows
    // in Hermes costs tens of ms on device and must not pollute the timing.
    const base = Math.floor(performance.now()) % 100000;
    const payloads = [0, 1, 2].map((i) => realisticRows(1300, 900, base + i));
    let w = 0;
    const waves = await timed(3, async () => {
      await ingest('industry', payloads[w++]);
    });
    done('parse1mb', median(waves));
  }

  onProgress('SQLite single-row inserts (20 x 1 row)...');
  {
    const payloads = Array.from({ length: 20 }, (_, rev) => realisticRows(1, 901, rev));
    let w = 0;
    const waves = await timed(20, async () => {
      await ingest('industry', payloads[w++]);
    });
    done('sqliteSingle', median(waves));
    // same measurement graded against the offline-first DB comparison suite
    done('offlineDbInsert', median(waves));
  }

  onProgress('SQLite bulk insert (3 x 1000 rows)...');
  {
    const payloads = [0, 1, 2].map((rev) => realisticRows(1000, 902, rev));
    let w = 0;
    const waves = await timed(3, async () => {
      await ingest('industry', payloads[w++]);
    });
    done('sqliteBulk1k', median(waves));
  }

  onProgress('marshal 10k objects into JS (5 reads)...');
  {
    await registerSource({
      source_id: 'industry_10k',
      format: 'Json',
      collection: 'industry_10k',
      natural_key_field: 'id',
      timestamp_field: null,
      priority: 1,
    });
    await ingest('industry_10k', realisticRows(10000, 903));
    const waves = await timed(5, () => {
      fastPath().queryEntriesObjects('industry_10k');
    });
    done('marshal10k', median(waves));

    onProgress('flat buffer + lazy view over 10k rows (5 reads)...');
    const lazyWaves = await timed(5, () => {
      const lazy = createLazyEntryRows(fastPath().queryEntriesBuffer('industry_10k'));
      for (let i = 0; i < Math.min(20, lazy.length); i++) lazy.row(i);
    });
    done('marshalLazy', median(lazyWaves));
    // same measurement graded against the STED RN-storage data-load table
    done('rnStorageLoad10k', median(lazyWaves));
  }

  onProgress('dead-letter 100 bad payloads (3 waves)...');
  {
    // rows missing the natural key field are dead-lettered, not stored. Each
    // wave's payload differs so the whole-batch hash skip can't fire — every
    // wave really writes 100 dead-letter rows.
    const bads = [0, 1, 2].map((w) =>
      JSON.stringify(Array.from({ length: 100 }, (_, i) => ({ not_the_key: i, junk: `x${w}` }))),
    );
    let w = 0;
    const waves = await timed(3, async () => {
      await ingest('industry', bads[w++]).catch(() => undefined);
    });
    done('dlq100', median(waves));
  }

  return results;
}
