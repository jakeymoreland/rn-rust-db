export type Anchor = { edge: number; frac: number };

const RELIABILITY_IDS = [
  'reliabilityInterruptedTxn',
  'reliabilityCorruptRecovery',
  'reliabilityRetryIdempotent',
  'reliabilityReopenIntegrity',
] as const;
type ReliabilityId = (typeof RELIABILITY_IDS)[number];

export const RELIABILITY_POINTS: Record<ReliabilityId, number> = {
  reliabilityInterruptedTxn: 3,
  reliabilityCorruptRecovery: 2,
  reliabilityRetryIdempotent: 3,
  reliabilityReopenIntegrity: 2,
};

const third = (a: number, b: number, c: number, d: number): Anchor[] => [
  { edge: a, frac: 1 },
  { edge: b, frac: 2 / 3 },
  { edge: c, frac: 1 / 3 },
  { edge: d, frac: 0 },
];

// Threshold bands from docs/superpowers/specs/2026-07-16-benchmark-scoring-design.md.
// All metrics are lower-is-better; value <= first edge earns the full fraction,
// value >= last edge earns 0, and values in between interpolate log-linearly.
export const ANCHORS = {
  nativeSyncCallMs: third(0.05, 0.2, 1, 5),
  nativeAsyncCallMs: third(0.1, 0.5, 2, 10),
  nativeEventLatencyMs: third(1, 5, 20, 50),
  storageIngestUsPerRow: third(15, 50, 200, 1000),
  storageTickIngestMs: third(5, 16, 50, 150),
  storageHydrateMs: third(50, 200, 1000, 5000),
  storageMaxGapMs: third(17, 50, 200, 1000),
  queryBuffer100kMs: [
    { edge: 20, frac: 1 },
    { edge: 50, frac: 0.75 },
    { edge: 100, frac: 0.5 },
    { edge: 250, frac: 0.25 },
  ] as Anchor[], // >=250 -> 0 via the >=-last-edge rule
  interopObjectsVsBufferRatio: third(2, 5, 10, 20),
  interopListCommitMs: third(50, 150, 400, 1000),
  syncTickEventMedianMs: third(5, 16, 50, 150),
  syncTickEventP95Ms: third(16, 50, 150, 500),
  syncIngestUnderLoadMs: third(150, 400, 1500, 5000),
  syncListDroppedFramePct: third(1, 5, 15, 30),
  syncListUpdateLatencyMs: third(50, 150, 400, 1000),
} as const;

export type MetricId = keyof typeof ANCHORS | ReliabilityId;
export type BenchMetrics = Partial<Record<MetricId, number>>;
export type CategoryScore = { earned: number; max: number; measured: boolean };
export type BenchmarkScore = {
  overall: { earned: number; available: number };
  native: CategoryScore;
  storage: CategoryScore;
  query: CategoryScore;
  interop: CategoryScore;
  sync: CategoryScore;
  reliability: CategoryScore;
};

export function metricFrac(value: number, anchors: readonly Anchor[]): number {
  const first = anchors[0];
  const last = anchors[anchors.length - 1];
  if (value <= first.edge || value <= 0) return first.frac;
  if (value >= last.edge) return 0;
  for (let i = 1; i < anchors.length; i++) {
    const a = anchors[i - 1];
    const b = anchors[i];
    if (value < b.edge) {
      const t = (Math.log(value) - Math.log(a.edge)) / (Math.log(b.edge) - Math.log(a.edge));
      return a.frac + (b.frac - a.frac) * t;
    }
  }
  return 0;
}

const BANDED_CATEGORIES = {
  native: { max: 15, metrics: ['nativeSyncCallMs', 'nativeAsyncCallMs', 'nativeEventLatencyMs'] },
  storage: {
    max: 20,
    metrics: ['storageIngestUsPerRow', 'storageTickIngestMs', 'storageHydrateMs', 'storageMaxGapMs'],
  },
  query: { max: 20, metrics: ['queryBuffer100kMs'] },
  interop: { max: 10, metrics: ['interopObjectsVsBufferRatio', 'interopListCommitMs'] },
  sync: {
    max: 25,
    metrics: [
      'syncTickEventMedianMs',
      'syncTickEventP95Ms',
      'syncIngestUnderLoadMs',
      'syncListDroppedFramePct',
      'syncListUpdateLatencyMs',
    ],
  },
} as const;

export function score(metrics: BenchMetrics): BenchmarkScore {
  const cat = (key: keyof typeof BANDED_CATEGORIES): CategoryScore => {
    const { max, metrics: ids } = BANDED_CATEGORIES[key];
    const fracs = (ids as readonly (keyof typeof ANCHORS)[])
      .filter((id) => metrics[id] !== undefined)
      .map((id) => metricFrac(metrics[id]!, ANCHORS[id]));
    if (fracs.length === 0) return { earned: 0, max, measured: false };
    return { earned: (fracs.reduce((a, b) => a + b, 0) / fracs.length) * max, max, measured: true };
  };
  const relMeasured = RELIABILITY_IDS.some((id) => metrics[id] !== undefined);
  const reliability: CategoryScore = {
    earned: RELIABILITY_IDS.reduce((sum, id) => sum + (metrics[id] ? RELIABILITY_POINTS[id] : 0), 0),
    max: 10,
    measured: relMeasured,
  };
  const cats = {
    native: cat('native'),
    storage: cat('storage'),
    query: cat('query'),
    interop: cat('interop'),
    sync: cat('sync'),
    reliability,
  };
  const measured = Object.values(cats).filter((c) => c.measured);
  return {
    overall: {
      earned: measured.reduce((s, c) => s + c.earned, 0),
      available: measured.reduce((s, c) => s + c.max, 0),
    },
    ...cats,
  };
}
