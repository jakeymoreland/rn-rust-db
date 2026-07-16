import { renderScorecard, toMarkdown } from '../markdown';
import { score } from '../score';

describe('renderScorecard', () => {
  it('renders measured, starred, and unmeasured rows', () => {
    const card = renderScorecard(
      score({ nativeSyncCallMs: 0.01, nativeAsyncCallMs: 0.05, nativeEventLatencyMs: 0.5 }),
    );
    expect(card).toContain('Native Calls');
    expect(card).toContain('15/15 ⭐');
    expect(card).toContain('Sync Engine');
    expect(card).toContain('--/25');
    expect(card).toContain('Current Score');
    expect(card).toContain('15/15'); // overall earned/available
  });

  it('rounds earned to integers for display', () => {
    const card = renderScorecard(score({ queryBuffer100kMs: 50 }));
    expect(card).toContain('15/20');
    expect(card).toContain('Query Throughput');
  });

  it('does not star partial categories', () => {
    const card = renderScorecard(score({ queryBuffer100kMs: 50 }));
    expect(card).not.toContain('15/20 ⭐');
  });
});

describe('toMarkdown', () => {
  it('includes scorecard, results table, and reliability footnote', () => {
    const out = {
      results: [{ name: 'call-overhead sync', iterations: 1000, totalMs: 16.1, perOpMs: 0.016, note: 'x' }],
      metrics: { nativeSyncCallMs: 0.016 },
      score: score({ nativeSyncCallMs: 0.016 }),
    };
    const md = toMarkdown('ios', out);
    expect(md).toContain('### ios');
    expect(md).toContain('| call-overhead sync | 1000 | 16.1 | 0.016 |');
    expect(md).toContain('Current Score');
    expect(md).toContain('in-process proxy');
  });
});
