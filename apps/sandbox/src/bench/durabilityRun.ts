// What a single insert costs at each durability level, measured on device.
//
// The engine defaults to WAL + `synchronous = NORMAL`, which survives an app
// crash but not power loss. That is the standard mobile setting and it is what
// the "single-row insert" number in the industry comparison is measured at — a
// distinction worth publishing rather than burying, since the honest comparison
// against another database depends entirely on what IT was configured for.
//
// On Apple platforms there is a second trapdoor: a plain fsync() returns once
// the write reaches the drive cache, not the platter. F_FULLFSYNC is the real
// barrier, and the gap between them is large.
import { executeRaw, ingest, registerSource } from '@rn-experiments/reconcile-engine';
import { median, sleep } from './harness';

export type DurabilityResult = {
  mode: string;
  survives: string;
  msPerInsert: number;
  /** Relative to the engine default (NORMAL). */
  tax: string;
};

const INSERTS = 60;
const WARMUP = 10;

const MODES: Array<{ sync: string; fullfsync: boolean; label: string; survives: string }> = [
  { sync: 'OFF', fullfsync: false, label: 'OFF', survives: 'nothing' },
  { sync: 'NORMAL', fullfsync: false, label: 'NORMAL (engine default)', survives: 'app crash' },
  { sync: 'FULL', fullfsync: false, label: 'FULL', survives: 'app crash, reaches drive cache' },
  { sync: 'FULL', fullfsync: true, label: 'FULL + F_FULLFSYNC', survives: 'power loss' },
];

/** One message-shaped row, the sort an offline-first DB comparison inserts. */
function row(i: number): string {
  return JSON.stringify([
    {
      id: `m${i}`,
      sender: `user${i}`,
      body: 'hello there, this is a chat message body '.repeat(3),
      sent_at: '2026-08-06T00:00:00Z',
      read: false,
    },
  ]);
}

async function setDurability(sync: string, fullfsync: boolean): Promise<void> {
  const res = JSON.parse(
    await executeRaw(JSON.stringify({ cmd: 'setDurability', args: [sync, fullfsync ? '1' : '0'] })),
  );
  if (!res.ok) throw new Error(`setDurability failed: ${JSON.stringify(res)}`);
}

export async function runDurability(onProgress: (m: string) => void): Promise<DurabilityResult[]> {
  await registerSource({
    source_id: 'dur',
    format: 'Json',
    collection: 'dur',
    natural_key_field: 'id',
    timestamp_field: null,
    priority: 1,
  });

  const raw: Array<{ label: string; survives: string; ms: number }> = [];
  let seq = 0;
  for (const mode of MODES) {
    onProgress(`durability: ${mode.label}...`);
    await setDurability(mode.sync, mode.fullfsync);
    const times: number[] = [];
    for (let i = 0; i < INSERTS; i++) {
      const payload = row(seq++); // fresh key every time — always a real insert
      const t = performance.now();
      const s = await ingest('dur', payload);
      const ms = performance.now() - t;
      if (s.inserted !== 1) throw new Error(`expected an insert, got ${JSON.stringify(s)}`);
      if (i >= WARMUP) times.push(ms);
      await sleep(0);
    }
    raw.push({ label: mode.label, survives: mode.survives, ms: median(times) });
  }

  // Leave the engine as we found it.
  await setDurability('NORMAL', false);

  const baseline = raw.find((r) => r.label.startsWith('NORMAL'))?.ms ?? raw[0].ms;
  return raw.map((r) => ({
    mode: r.label,
    survives: r.survives,
    msPerInsert: r.ms,
    tax: r.ms / baseline >= 1 ? `${(r.ms / baseline).toFixed(2)}x` : `${(r.ms / baseline).toFixed(2)}x`,
  }));
}

export function renderDurability(results: DurabilityResult[]): string {
  const rows = results.map(
    (r) =>
      `${r.mode.padEnd(24)} ${r.msPerInsert.toFixed(4).padStart(9)} ms  ${r.tax.padStart(8)}  survives: ${r.survives}`,
  );
  return [
    'single insert: parse -> normalize -> content-hash -> field merge -> SQLite commit',
    ...rows,
  ].join('\n');
}
