/// Matches `text` against `pattern`, where `*` in the pattern matches any
/// run of zero or more characters (all other characters must match exactly).
///
/// Implemented iteratively using the classic two-pointer wildcard algorithm:
/// we walk `text` and `pattern` in lockstep, and whenever we hit a `*` we
/// remember its position plus how far into `text` we were (the "backtrack
/// point"). If a later mismatch occurs, we rewind to just after that `*` and
/// advance the backtrack point by one character instead of recursing. This
/// keeps the matcher O(n*m) worst case with no call-stack growth, unlike a
/// naive recursive/backtracking implementation which can blow up
/// exponentially on adversarial patterns like `"*a*a*a...*b"`.
pub fn glob_match(pattern: &str, text: &str) -> bool {
    let p: Vec<char> = pattern.chars().collect();
    let t: Vec<char> = text.chars().collect();

    let mut pi = 0usize;
    let mut ti = 0usize;
    let mut star_idx: Option<usize> = None;
    let mut match_idx = 0usize;

    while ti < t.len() {
        if pi < p.len() && p[pi] == t[ti] {
            pi += 1;
            ti += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star_idx = Some(pi);
            match_idx = ti;
            pi += 1;
        } else if let Some(si) = star_idx {
            pi = si + 1;
            match_idx += 1;
            ti = match_idx;
        } else {
            return false;
        }
    }

    while pi < p.len() && p[pi] == '*' {
        pi += 1;
    }

    pi == p.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn basics() {
        assert!(glob_match("*", "anything"));
        assert!(glob_match("user:*", "user:1"));
        assert!(!glob_match("user:*", "cfg:1"));
        assert!(glob_match("a*c", "abc"));
        assert!(glob_match("a*c", "ac"));
        assert!(!glob_match("a*c", "ab"));
        assert!(glob_match("", ""));
        assert!(!glob_match("", "x"));
        assert!(glob_match("*", ""));
        assert!(glob_match("abc", "abc"));
        assert!(!glob_match("abc", "abd"));
        assert!(glob_match("*a*b*", "xxaxxbxx"));
        assert!(!glob_match("*a*b*", "xxaxx"));
    }

    /// A pathological pattern that defeats naive recursive backtracking
    /// (exponential blowup) but must resolve quickly with the iterative
    /// two-pointer algorithm. The pattern can never match since the text
    /// contains no 'b', so this should return false almost instantly.
    #[test]
    fn pathological_pattern_is_fast() {
        let pattern = format!("{}{}", "*a".repeat(30), "*b");
        let text = "a".repeat(200);
        assert!(!glob_match(&pattern, &text));
    }
}
