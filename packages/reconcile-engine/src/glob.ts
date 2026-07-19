// Direct port of the Rust engine's `glob_match` (rust/src/glob.rs). Keeping the
// TS subscription filter identical to the native pub/sub matcher avoids the
// audit S17 divergence, where a regex translation of `*` silently failed to
// match channels containing characters the regex `.` excludes (e.g. newlines).
//
// `*` matches any run of zero or more characters (including newlines); every
// other character must match exactly. Iterative two-pointer algorithm, O(n*m)
// worst case with no recursion, so adversarial patterns can't blow the stack.
export function globMatch(pattern: string, text: string): boolean {
  const p = Array.from(pattern);
  const t = Array.from(text);
  let pi = 0;
  let ti = 0;
  let starIdx = -1;
  let matchIdx = 0;

  while (ti < t.length) {
    if (pi < p.length && p[pi] === t[ti]) {
      pi++;
      ti++;
    } else if (pi < p.length && p[pi] === '*') {
      starIdx = pi;
      matchIdx = ti;
      pi++;
    } else if (starIdx !== -1) {
      pi = starIdx + 1;
      matchIdx++;
      ti = matchIdx;
    } else {
      return false;
    }
  }

  while (pi < p.length && p[pi] === '*') {
    pi++;
  }
  return pi === p.length;
}
