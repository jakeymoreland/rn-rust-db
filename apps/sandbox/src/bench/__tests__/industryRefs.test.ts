import { INDUSTRY_REFS, renderIndustry, verdict } from '../industryRefs';

const ref = (key: string) => {
  const r = INDUSTRY_REFS.find((x) => x.key === key);
  if (!r) throw new Error(`no ref ${key}`);
  return r;
};

describe('verdict', () => {
  it('classifies against the reference band', () => {
    const marshal = ref('marshal10k'); // 30–50 ms
    expect(verdict(5, marshal)).toBe('better');
    expect(verdict(30, marshal)).toBe('within');
    expect(verdict(50, marshal)).toBe('within');
    expect(verdict(51, marshal)).toBe('slower');
  });

  it('never grades a row whose reference does different work', () => {
    // A bare-INSERT reference against our full parse + reconcile + write is
    // not a comparison, so these rows report a number without a verdict.
    for (const key of ['ingest1mbFull', 'sqliteSingle', 'sqliteBulk1k']) {
      expect(verdict(0.0001, ref(key))).toBe('unscored');
      expect(verdict(9999, ref(key))).toBe('unscored');
    }
  });

  it('still grades the like-for-like rows', () => {
    // parse1mb now measures our parse phase against a serde-parse reference.
    expect(verdict(3.2, ref('parse1mb'))).toBe('within');
    expect(verdict(1, ref('parse1mb'))).toBe('better');
    expect(verdict(16, ref('parse1mb'))).toBe('slower');
  });
});

describe('renderIndustry', () => {
  it('renders ours vs reference with verdict marks and caveats', () => {
    const out = renderIndustry([
      { ref: ref('jsiRoundtrip'), oursMs: 0.016 },
      { ref: ref('kvWrite'), oursMs: 0.05 },
    ]);
    expect(out).toContain('JSI bridge');
    expect(out).toContain('✓ within');
    expect(out).toContain('✗ slower');
    expect(out).toContain('memory-first with SQLite write-behind');
  });
});
