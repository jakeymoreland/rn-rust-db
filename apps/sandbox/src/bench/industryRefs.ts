// Industry-reference ranges for a JSI/Rust reconcile stack on modern mobile
// hardware (iPhone 14+/SD 8 Gen 2+). Ranges are indicative, compiled from
// public benchmarks; ours measure the same operation through this engine,
// with any semantic differences called out per row.
export type IndustryRef = {
  key: string;
  component: string;
  operation: string;
  refLoMs: number;
  refHiMs: number;
  unit: 'ms/op' | 'ms total';
  caveat?: string;
};

export const INDUSTRY_REFS: IndustryRef[] = [
  {
    key: 'jsiRoundtrip',
    component: 'JSI bridge',
    operation: 'sync roundtrip (no-op get)',
    refLoMs: 0.01,
    refHiMs: 0.05,
    unit: 'ms/op',
  },
  {
    key: 'kvWrite',
    component: 'In-memory store',
    operation: 'redis-style set',
    refLoMs: 0.002,
    refHiMs: 0.003,
    unit: 'ms/op',
    caveat: 'reference is a pure in-process hashmap; ours persists through SQLite',
  },
  {
    key: 'kvRead',
    component: 'In-memory store',
    operation: 'redis-style get',
    refLoMs: 0.002,
    refHiMs: 0.002,
    unit: 'ms/op',
    caveat: 'reference is a pure in-process hashmap; ours reads through SQLite',
  },
  {
    key: 'parse1mb',
    component: 'Serialization',
    operation: '~1 MB JSON ingest',
    refLoMs: 2,
    refHiMs: 15,
    unit: 'ms total',
    caveat: 'reference is serde parse only; ours also reconciles + writes SQLite',
  },
  {
    key: 'sqliteSingle',
    component: 'SQLite (WAL)',
    operation: 'single-row insert',
    refLoMs: 0.5,
    refHiMs: 1.5,
    unit: 'ms/op',
    caveat: 'reference is a bare INSERT; ours parses, normalizes, and reconciles per row',
  },
  {
    key: 'sqliteBulk1k',
    component: 'SQLite (WAL)',
    operation: '1,000-row bulk insert (one txn)',
    refLoMs: 12,
    refHiMs: 25,
    unit: 'ms total',
    caveat: 'reference is a bare INSERT loop; ours parses, content-hashes, and reconciles per row',
  },
  {
    key: 'marshal10k',
    component: 'JSI marshaling',
    operation: '10k objects into JS',
    refLoMs: 30,
    refHiMs: 50,
    unit: 'ms total',
  },
  {
    key: 'marshalLazy',
    component: 'JSI marshaling',
    operation: '10k rows as flat buffer + lazy view (20 materialized)',
    refLoMs: 0.5,
    refHiMs: 1.5,
    unit: 'ms total',
  },
  {
    key: 'dlq100',
    component: 'Dead-letter queue',
    operation: 'dead-letter 100 bad payloads',
    refLoMs: 5,
    refHiMs: 8,
    unit: 'ms total',
  },
];

export type Verdict = 'better' | 'within' | 'slower';

export function verdict(oursMs: number, ref: IndustryRef): Verdict {
  if (oursMs < ref.refLoMs) return 'better';
  if (oursMs <= ref.refHiMs) return 'within';
  return 'slower';
}

export type IndustryResult = { ref: IndustryRef; oursMs: number };

const MARK: Record<Verdict, string> = { better: '✓ faster', within: '✓ within', slower: '✗ slower' };

export function renderIndustry(results: IndustryResult[]): string {
  const fmt = (ms: number) => (ms < 0.1 ? ms.toFixed(4) : ms < 10 ? ms.toFixed(2) : ms.toFixed(1));
  const lines = results.map(({ ref, oursMs }) => {
    const refStr = ref.refLoMs === ref.refHiMs ? `~${fmt(ref.refLoMs)}` : `${fmt(ref.refLoMs)}–${fmt(ref.refHiMs)}`;
    const head = `${ref.component}: ${ref.operation}\n  ours ${fmt(oursMs)} ${ref.unit} vs industry ${refStr} — ${MARK[verdict(oursMs, ref)]}`;
    return ref.caveat ? `${head}\n  (${ref.caveat})` : head;
  });
  return lines.join('\n');
}
