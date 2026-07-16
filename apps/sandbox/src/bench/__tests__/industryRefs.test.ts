import { INDUSTRY_REFS, renderIndustry, verdict } from '../industryRefs';

const ref = (key: string) => {
  const r = INDUSTRY_REFS.find((x) => x.key === key);
  if (!r) throw new Error(`no ref ${key}`);
  return r;
};

describe('verdict', () => {
  it('classifies against the reference band', () => {
    const bulk = ref('sqliteBulk1k'); // 12–25 ms
    expect(verdict(5, bulk)).toBe('better');
    expect(verdict(12, bulk)).toBe('within');
    expect(verdict(25, bulk)).toBe('within');
    expect(verdict(26, bulk)).toBe('slower');
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
    expect(out).toContain('pure in-process hashmap');
  });
});
