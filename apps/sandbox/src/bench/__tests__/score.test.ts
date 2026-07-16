import { score, metricFrac, ANCHORS, type BenchMetrics } from '../score';

describe('metricFrac', () => {
  const a = [...ANCHORS.nativeSyncCallMs]; // edges 0.05/0.2/1/5, fracs 1, 2/3, 1/3, 0
  it('caps at 1 below first edge', () => expect(metricFrac(0.01, a)).toBe(1));
  it('is 0 at/after last edge', () => expect(metricFrac(5, a)).toBe(0));
  it('hits band fracs at edges', () => expect(metricFrac(0.2, a)).toBeCloseTo(2 / 3));
  it('interpolates log-linearly inside a band', () => {
    const f = metricFrac(0.1, a); // between 0.05 (frac 1) and 0.2 (frac 2/3)
    expect(f).toBeLessThan(1);
    expect(f).toBeGreaterThan(2 / 3);
  });
  it('is monotonically non-increasing', () => {
    let prev = Infinity;
    for (const v of [0.01, 0.05, 0.1, 0.2, 0.5, 1, 3, 5, 50]) {
      const f = metricFrac(v, a);
      expect(f).toBeLessThanOrEqual(prev);
      prev = f;
    }
  });
});

describe('score', () => {
  it('marks empty categories unmeasured and excludes them from available', () => {
    const s = score({ nativeSyncCallMs: 0.01, nativeAsyncCallMs: 0.05, nativeEventLatencyMs: 0.5 });
    expect(s.native).toEqual({ earned: 15, max: 15, measured: true });
    expect(s.query.measured).toBe(false);
    expect(s.overall.available).toBe(15);
    expect(s.overall.earned).toBeCloseTo(15);
  });
  it('scores query bands per spec', () => {
    expect(score({ queryBuffer100kMs: 10 }).query.earned).toBe(20);
    expect(score({ queryBuffer100kMs: 300 }).query.earned).toBe(0);
    expect(score({ queryBuffer100kMs: 50 }).query.earned).toBeCloseTo(15);
  });
  it('averages present metrics only within a category', () => {
    const s = score({ nativeSyncCallMs: 0.01 }); // 1 of 3 native metrics present
    expect(s.native.earned).toBe(15);
  });
  it('sums reliability check points', () => {
    const s = score({
      reliabilityInterruptedTxn: 1,
      reliabilityCorruptRecovery: 0,
      reliabilityRetryIdempotent: 1,
      reliabilityReopenIntegrity: 1,
    });
    expect(s.reliability).toEqual({ earned: 8, max: 10, measured: true });
  });
  it('full house = 100/100', () => {
    const m: BenchMetrics = {
      nativeSyncCallMs: 0.01,
      nativeAsyncCallMs: 0.05,
      nativeEventLatencyMs: 0.5,
      storageIngestUsPerRow: 10,
      storageTickIngestMs: 2,
      storageHydrateMs: 30,
      storageMaxGapMs: 10,
      queryBuffer100kMs: 15,
      interopObjectsVsBufferRatio: 1.5,
      interopListCommitMs: 40,
      syncTickEventMedianMs: 2,
      syncTickEventP95Ms: 10,
      syncIngestUnderLoadMs: 100,
      syncListDroppedFramePct: 0.5,
      syncListUpdateLatencyMs: 30,
      reliabilityInterruptedTxn: 1,
      reliabilityCorruptRecovery: 1,
      reliabilityRetryIdempotent: 1,
      reliabilityReopenIntegrity: 1,
    };
    const s = score(m);
    expect(s.overall).toEqual({ earned: 100, available: 100 });
  });
});
