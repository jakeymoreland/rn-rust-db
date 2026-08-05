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
  /**
   * Informational only: there is no comparable published figure, so the row
   * reports our number without passing judgement. Grading ourselves against a
   * reference that does materially less work produces a meaningless verdict.
   */
  unscored?: boolean;
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
    caveat: 'ours is memory-first with SQLite write-behind, via dedicated JSI host functions',
  },
  {
    key: 'kvRead',
    component: 'In-memory store',
    operation: 'redis-style get',
    refLoMs: 0.002,
    refHiMs: 0.002,
    unit: 'ms/op',
    caveat: 'ours reads the in-memory cache (SQLite only on cold miss)',
  },
  {
    // Like-for-like: the reference measures a serde parse of ~1 MB and nothing
    // else, so this row measures OUR parse and nothing else — the engine
    // reports it as timings.parse_ms. The full-pipeline number is the
    // `ingest1mbFull` row below, which has no industry counterpart because no
    // published figure covers parse + reconcile + write.
    key: 'parse1mb',
    component: 'Serialization',
    operation: '~1 MB JSON parse (parse phase only)',
    refLoMs: 2,
    refHiMs: 15,
    unit: 'ms total',
  },
  {
    key: 'ingest1mbFull',
    component: 'Serialization',
    operation: '~1 MB ingest end to end (parse + reconcile + write)',
    refLoMs: 0,
    refHiMs: 0,
    unit: 'ms total',
    unscored: true,
    caveat: 'no comparable published reference — a parser benchmark is not a database write',
  },
  {
    key: 'sqliteSingle',
    component: 'SQLite (WAL)',
    operation: 'single-row insert',
    refLoMs: 0,
    refHiMs: 0,
    unit: 'ms/op',
    unscored: true,
    caveat: 'reference was a bare INSERT — not comparable. See the offline-first DB row, which compares full inserts',
  },
  {
    key: 'sqliteBulk1k',
    component: 'SQLite (WAL)',
    operation: '1,000-row bulk insert (one txn)',
    refLoMs: 0,
    refHiMs: 0,
    unit: 'ms total',
    unscored: true,
    caveat: 'reference was a bare INSERT loop — not comparable; ours parses, content-hashes and reconciles per row',
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
    caveat: 'reference transfers a pre-built buffer; ours includes the 10k-row SQLite query — see marshalLazyFair for the 1:1',
  },
  {
    // The apples-to-apples version of marshalLazy: the buffer is fetched ONCE
    // (query cost excluded, like the reference), and each rep times only the
    // lazy-view construction + materializing 20 rows. Directly comparable to
    // the "transfer a pre-built buffer" reference.
    key: 'marshalLazyFair',
    component: 'JSI marshaling (1:1)',
    operation: 'lazy view + 20 materialized over a pre-fetched 10k buffer',
    refLoMs: 0.5,
    refHiMs: 1.5,
    unit: 'ms total',
    caveat: 'query excluded (buffer fetched once), matching the reference; measures only view build + materialize',
  },
  {
    key: 'offlineDbInsert',
    component: 'vs offline-first DBs',
    operation: 'insert one message (RxDB comparison suite)',
    refLoMs: 5,
    refHiMs: 16,
    unit: 'ms/op',
    caveat: 'reference range is WatermelonDB/rxdb-lokijs..pouchdb/aws in a browser; ours is native with full reconcile',
  },
  {
    key: 'rnStorageLoad10k',
    component: 'vs RN storage libs',
    operation: 'load 10k records to usable (STED paper suite)',
    refLoMs: 18,
    refHiMs: 68,
    unit: 'ms total',
    caveat: 'reference (AsyncStorage 18 / Realm 46 / SQLite 68, iOS sim) loads to memory; ours indexes a queryable lazy view on-device',
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

export type Verdict = 'better' | 'within' | 'slower' | 'unscored';

export function verdict(oursMs: number, ref: IndustryRef): Verdict {
  if (ref.unscored) return 'unscored';
  if (oursMs < ref.refLoMs) return 'better';
  if (oursMs <= ref.refHiMs) return 'within';
  return 'slower';
}

export type IndustryResult = { ref: IndustryRef; oursMs: number };

const MARK: Record<Verdict, string> = { better: '✓ faster', within: '✓ within', slower: '✗ slower', unscored: '· informational' };

export function renderIndustry(results: IndustryResult[]): string {
  const fmt = (ms: number) => (ms < 0.1 ? ms.toFixed(4) : ms < 10 ? ms.toFixed(2) : ms.toFixed(1));
  const lines = results.map(({ ref, oursMs }) => {
    const refStr = ref.refLoMs === ref.refHiMs ? `~${fmt(ref.refLoMs)}` : `${fmt(ref.refLoMs)}–${fmt(ref.refHiMs)}`;
    const head = `${ref.component}: ${ref.operation}\n  ours ${fmt(oursMs)} ${ref.unit} vs industry ${refStr} — ${MARK[verdict(oursMs, ref)]}`;
    return ref.caveat ? `${head}\n  (${ref.caveat})` : head;
  });
  return lines.join('\n');
}
