pub fn glob_match(pattern: &str, text: &str) -> bool {
    let p: Vec<char> = pattern.chars().collect();
    let t: Vec<char> = text.chars().collect();
    fn m(p: &[char], t: &[char]) -> bool {
        match (p.first(), t.first()) {
            (None, None) => true,
            (Some('*'), _) => m(&p[1..], t) || (!t.is_empty() && m(p, &t[1..])),
            (Some(pc), Some(tc)) if pc == tc => m(&p[1..], &t[1..]),
            _ => false,
        }
    }
    m(&p, &t)
}
