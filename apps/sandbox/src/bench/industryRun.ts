import { executeRawSync, ingest, registerSource } from '@rn-experiments/reconcile-engine';

import { fastPath, median, sleep } from './harness';
import { REALISTIC_FIELDS_CSV, realisticRows } from './data';
import { createLazyRows } from './decode';
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

  onProgress('redis-style set/get (500 sync ops each)...');
  {
    const t0 = performance.now();
    for (let i = 0; i < 500; i++) {
      executeRawSync(JSON.stringify({ cmd: 'set', args: [`industry:kv:${i % 50}`, `v${i}`] }));
    }
    done('kvWrite', (performance.now() - t0) / 500);
    const t1 = performance.now();
    for (let i = 0; i < 500; i++) {
      executeRawSync(JSON.stringify({ cmd: 'get', args: [`industry:kv:${i % 50}`] }));
    }
    done('kvRead', (performance.now() - t1) / 500);
  }

  onProgress('~1 MB JSON ingest (3 update waves)...');
  {
    // ~1300 realistic rows ≈ 1 MB; a fresh rev each wave forces real updates
    // instead of content-hash skips.
    const waves = await timed(3, async () => {
      await ingest('industry', realisticRows(1300, 900, Math.floor(performance.now()) % 100000));
    });
    done('parse1mb', median(waves));
  }

  onProgress('SQLite single-row inserts (20 x 1 row)...');
  {
    let rev = 0;
    const waves = await timed(20, async () => {
      await ingest('industry', realisticRows(1, 901, rev++));
    });
    done('sqliteSingle', median(waves));
  }

  onProgress('SQLite bulk insert (3 x 1000 rows)...');
  {
    let rev = 0;
    const waves = await timed(3, async () => {
      await ingest('industry', realisticRows(1000, 902, rev++));
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
      const lazy = createLazyRows(fastPath().queryEntriesSchemaBuffer('industry_10k', REALISTIC_FIELDS_CSV));
      for (let i = 0; i < Math.min(20, lazy.length); i++) lazy.row(i);
    });
    done('marshalLazy', median(lazyWaves));
  }

  onProgress('dead-letter 100 bad payloads (3 waves)...');
  {
    // rows missing the natural key field are dead-lettered, not stored
    const bad = JSON.stringify(Array.from({ length: 100 }, (_, i) => ({ not_the_key: i, junk: 'x' })));
    const waves = await timed(3, async () => {
      await ingest('industry', bad).catch(() => undefined);
    });
    done('dlq100', median(waves));
  }

  return results;
}
