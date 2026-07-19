import { globMatch } from '../glob';

// Mirrors the Rust glob.rs test vectors (audit S17) so the TS and native
// matchers can't silently diverge.
describe('globMatch parity with Rust glob_match', () => {
  const cases: Array<[string, string, boolean]> = [
    ['*', 'anything', true],
    ['user:*', 'user:1', true],
    ['user:*', 'cfg:1', false],
    ['a*c', 'abc', true],
    ['a*c', 'ac', true],
    ['a*c', 'ab', false],
    ['', '', true],
    ['', 'x', false],
    ['*', '', true],
    ['abc', 'abc', true],
    ['abc', 'abd', false],
    ['*a*b*', 'xxaxxbxx', true],
    ['*a*b*', 'xxaxx', false],
    // The regex translation (audit S17) failed these: `.` excludes newlines.
    ['changes:*', 'changes:foo\nbar', true],
    ['*', 'a\nb\r\nc', true],
    // regex metacharacters must be treated literally, not as regex
    ['a.c', 'axc', false],
    ['a.c', 'a.c', true],
  ];
  test.each(cases)('globMatch(%j, %j) === %s', (pattern, text, expected) => {
    expect(globMatch(pattern, text)).toBe(expected);
  });

  test('pathological pattern resolves quickly', () => {
    const pattern = '*a'.repeat(30) + '*b';
    const text = 'a'.repeat(200);
    expect(globMatch(pattern, text)).toBe(false);
  });
});
