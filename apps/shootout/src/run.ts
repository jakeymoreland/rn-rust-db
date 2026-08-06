import type { Contender } from './contender';
import { makeRows } from './contender';

export type Timing = { scenario: string; msPerOp: number; ops: number; note?: string };
export type ContenderResult = {
  name: string;
  configuration: string;
  durability: string;
  caveats: string[];
  timings: Timing[];
  error?: string;
};

const SINGLE_INSERTS = 60;
const WARMUP = 10;
const BULK = 1000;
const READ_SET = 10_000;

function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

const sleep = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/**
 * Runs one contender through every scenario.
 *
 * Each scenario re-sets up from empty, so a contender is never advantaged or
 * penalised by what a previous scenario left behind — a mistake that produced
 * a bogus result in this project's own benchmark suite more than once.
 */
export async function runContender(
  c: Contender,
  onProgress: (m: string) => void,
): Promise<ContenderResult> {
  const timings: Timing[] = [];
  const base: ContenderResult = {
    name: c.name,
    configuration: c.configuration,
    durability: c.durability,
    caveats: c.caveats ?? [],
    timings,
  };

  try {
    // ── single insert ────────────────────────────────────────────────────────
    onProgress(`${c.name}: single inserts...`);
    await c.setup();
    const rows = makeRows(SINGLE_INSERTS, 'single');
    const singles: number[] = [];
    for (let i = 0; i < SINGLE_INSERTS; i++) {
      const t = performance.now();
      await c.insertOne(rows[i]);
      const ms = performance.now() - t;
      if (i >= WARMUP) singles.push(ms);
      await sleep();
    }
    timings.push({ scenario: 'insert one', msPerOp: median(singles), ops: 1 });

    // ── bulk insert ──────────────────────────────────────────────────────────
    onProgress(`${c.name}: bulk insert ${BULK}...`);
    await c.setup();
    const bulk = makeRows(BULK, 'bulk');
    const t1 = performance.now();
    await c.insertMany(bulk);
    const bulkMs = performance.now() - t1;
    timings.push({
      scenario: `insert ${BULK}`,
      msPerOp: bulkMs / BULK,
      ops: BULK,
      note: `${bulkMs.toFixed(0)} ms total`,
    });

    // ── read paths, over a larger set ───────────────────────────────────────
    onProgress(`${c.name}: seeding ${READ_SET} for reads...`);
    await c.setup();
    const many = makeRows(READ_SET, 'read');
    await c.insertMany(many);

    onProgress(`${c.name}: read all ${READ_SET}...`);
    const readTimes: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t = performance.now();
      const n = await c.readAll();
      readTimes.push(performance.now() - t);
      if (n !== READ_SET) {
        timings.push({ scenario: 'read all — WRONG COUNT', msPerOp: NaN, ops: 0, note: `got ${n}` });
      }
      await sleep();
    }
    timings.push({ scenario: `read all ${READ_SET}`, msPerOp: median(readTimes), ops: 1 });

    if (c.readPage) {
      onProgress(`${c.name}: read page of 50...`);
      const pageTimes: number[] = [];
      for (let i = 0; i < 20; i++) {
        const t = performance.now();
        await c.readPage(50, Math.floor(READ_SET / 2));
        pageTimes.push(performance.now() - t);
        await sleep();
      }
      timings.push({ scenario: 'read page (50 @ mid)', msPerOp: median(pageTimes), ops: 1 });
    } else {
      timings.push({ scenario: 'read page (50 @ mid)', msPerOp: NaN, ops: 0, note: 'not supported' });
    }

    // ── update ───────────────────────────────────────────────────────────────
    onProgress(`${c.name}: update 500...`);
    const toUpdate = many.slice(0, 500);
    const t2 = performance.now();
    await c.updateSome(toUpdate);
    const updMs = performance.now() - t2;
    timings.push({
      scenario: 'update 500',
      msPerOp: updMs / 500,
      ops: 500,
      note: `${updMs.toFixed(0)} ms total`,
    });

    await c.teardown();
    return base;
  } catch (e) {
    await c.teardown().catch(() => {});
    return { ...base, error: String(e) };
  }
}

export function renderResults(results: ContenderResult[]): string {
  const scenarios = Array.from(
    new Set(results.flatMap((r) => r.timings.map((t) => t.scenario))),
  );
  const lines: string[] = [];
  lines.push('| scenario | ' + results.map((r) => r.name).join(' | ') + ' |');
  lines.push('|---|' + results.map(() => '---:').join('|') + '|');
  for (const s of scenarios) {
    const cells = results.map((r) => {
      const t = r.timings.find((x) => x.scenario === s);
      if (!t) return '—';
      if (Number.isNaN(t.msPerOp)) return t.note ?? 'n/a';
      return `${t.msPerOp < 1 ? t.msPerOp.toFixed(4) : t.msPerOp.toFixed(2)} ms`;
    });
    lines.push(`| ${s} | ${cells.join(' | ')} |`);
  }
  lines.push('');
  for (const r of results) {
    lines.push(`**${r.name}** — ${r.configuration} · survives: ${r.durability}`);
    for (const c of r.caveats) lines.push(`  - ${c}`);
    if (r.error) lines.push(`  - FAILED: ${r.error}`);
  }
  return lines.join('\n');
}
