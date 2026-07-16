use crate::error::EngineError;
use crate::glob::glob_match;
use crate::store::Store;
use rusqlite::params;
use std::collections::BTreeMap;

pub const RESERVED_PREFIXES: [&str; 4] = ["entry:", "idx:", "meta:", "changes:"];

fn check_writable(key: &str) -> Result<(), EngineError> {
    for p in RESERVED_PREFIXES {
        if key.starts_with(p) {
            return Err(EngineError::Command(format!(
                "key '{key}' is reserved (prefix '{p}')"
            )));
        }
    }
    Ok(())
}

/// Deletes key rows if expired. Returns true if the key was expired+purged.
fn purge_if_expired(store: &Store, key: &str, now_ms: i64) -> Result<bool, EngineError> {
    let expires: Option<i64> = store
        .conn
        .query_row(
            "SELECT expires_at FROM key_ttl WHERE key = ?1",
            params![key],
            |r| r.get(0),
        )
        .ok();
    if let Some(at) = expires {
        if now_ms >= at {
            store.conn.execute("DELETE FROM kv WHERE key = ?1", params![key])?;
            store.conn.execute("DELETE FROM hash WHERE key = ?1", params![key])?;
            store.conn.execute("DELETE FROM key_ttl WHERE key = ?1", params![key])?;
            return Ok(true);
        }
    }
    Ok(false)
}

pub fn get(store: &Store, key: &str, now_ms: i64) -> Result<Option<String>, EngineError> {
    if purge_if_expired(store, key, now_ms)? {
        return Ok(None);
    }
    Ok(store
        .conn
        .query_row("SELECT value FROM kv WHERE key = ?1", params![key], |r| r.get(0))
        .ok())
}

pub fn set(store: &Store, key: &str, value: &str) -> Result<(), EngineError> {
    check_writable(key)?;
    store.conn.execute(
        "INSERT INTO kv(key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    // Redis SET semantics: overwriting a key clears any existing TTL.
    store.conn.execute("DELETE FROM key_ttl WHERE key = ?1", params![key])?;
    Ok(())
}

pub fn del(store: &Store, key: &str) -> Result<bool, EngineError> {
    check_writable(key)?;
    let a = store.conn.execute("DELETE FROM kv WHERE key = ?1", params![key])?;
    let b = store.conn.execute("DELETE FROM hash WHERE key = ?1", params![key])?;
    store.conn.execute("DELETE FROM key_ttl WHERE key = ?1", params![key])?;
    Ok(a + b > 0)
}

pub fn mget(store: &Store, keys: &[String], now_ms: i64) -> Result<Vec<Option<String>>, EngineError> {
    keys.iter().map(|k| get(store, k, now_ms)).collect()
}

pub fn hset(store: &Store, key: &str, field: &str, value: &str) -> Result<(), EngineError> {
    check_writable(key)?;
    store.conn.execute(
        "INSERT INTO hash(key, field, value) VALUES (?1, ?2, ?3)
         ON CONFLICT(key, field) DO UPDATE SET value = excluded.value",
        params![key, field, value],
    )?;
    // Redis SET semantics: (re)writing a key clears any existing TTL.
    store.conn.execute("DELETE FROM key_ttl WHERE key = ?1", params![key])?;
    Ok(())
}

pub fn hget(store: &Store, key: &str, field: &str, now_ms: i64) -> Result<Option<String>, EngineError> {
    if purge_if_expired(store, key, now_ms)? {
        return Ok(None);
    }
    Ok(store
        .conn
        .query_row(
            "SELECT value FROM hash WHERE key = ?1 AND field = ?2",
            params![key, field],
            |r| r.get(0),
        )
        .ok())
}

pub fn hgetall(store: &Store, key: &str, now_ms: i64) -> Result<BTreeMap<String, String>, EngineError> {
    if let Some(rest) = key.strip_prefix("entry:") {
        if let Some((collection, natural_key)) = rest.split_once(':') {
            let row: Option<(String, i64)> = store
                .conn
                .query_row(
                    "SELECT fields, updated_at FROM entries WHERE collection = ?1 AND natural_key = ?2",
                    params![collection, natural_key],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .ok();
            return Ok(match row {
                None => BTreeMap::new(),
                Some((fields_json, updated_at)) => {
                    let mut m: BTreeMap<String, String> = serde_json::from_str(&fields_json)
                        .map_err(|e| EngineError::Storage(e.to_string()))?;
                    m.insert("_updated_at".into(), updated_at.to_string());
                    m
                }
            });
        }
    }
    if purge_if_expired(store, key, now_ms)? {
        return Ok(BTreeMap::new());
    }
    let mut stmt = store
        .conn
        .prepare("SELECT field, value FROM hash WHERE key = ?1")?;
    let rows = stmt.query_map(params![key], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
    let mut out = BTreeMap::new();
    for row in rows {
        let (f, v) = row?;
        out.insert(f, v);
    }
    Ok(out)
}

pub fn scan(store: &Store, pattern: &str, now_ms: i64) -> Result<Vec<String>, EngineError> {
    let mut keys: Vec<String> = Vec::new();
    let mut stmt = store.conn.prepare(
        "SELECT key FROM kv UNION SELECT DISTINCT key FROM hash",
    )?;
    let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
    for row in rows {
        keys.push(row?);
    }
    let mut stmt2 = store
        .conn
        .prepare("SELECT collection, natural_key FROM entries")?;
    let rows2 = stmt2.query_map([], |r| {
        Ok(format!("entry:{}:{}", r.get::<_, String>(0)?, r.get::<_, String>(1)?))
    })?;
    for row in rows2 {
        keys.push(row?);
    }
    let mut out = Vec::new();
    for k in keys {
        if glob_match(pattern, &k) && (k.starts_with("entry:") || !purge_if_expired(store, &k, now_ms)?) {
            out.push(k);
        }
    }
    Ok(out)
}

pub fn expire(store: &Store, key: &str, ttl_ms: i64, now_ms: i64) -> Result<(), EngineError> {
    check_writable(key)?;
    let exists: bool = store
        .conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM kv WHERE key = ?1 UNION SELECT 1 FROM hash WHERE key = ?1)",
            params![key],
            |r| r.get(0),
        )
        .unwrap_or(false);
    if !exists {
        return Err(EngineError::Command(format!("cannot expire missing key '{key}'")));
    }
    store.conn.execute(
        "INSERT INTO key_ttl(key, expires_at) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET expires_at = excluded.expires_at",
        params![key, now_ms + ttl_ms],
    )?;
    Ok(())
}

pub fn ttl(store: &Store, key: &str, now_ms: i64) -> Result<Option<i64>, EngineError> {
    if purge_if_expired(store, key, now_ms)? {
        return Ok(None);
    }
    let expires: Option<i64> = store
        .conn
        .query_row(
            "SELECT expires_at FROM key_ttl WHERE key = ?1",
            params![key],
            |r| r.get(0),
        )
        .ok();
    Ok(expires.map(|at| at - now_ms))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::Store;

    fn s() -> Store {
        Store::open(":memory:").unwrap()
    }

    #[test]
    fn set_get_roundtrip() {
        let st = s();
        set(&st, "a", "1").unwrap();
        assert_eq!(get(&st, "a", 0).unwrap(), Some("1".into()));
        assert_eq!(get(&st, "missing", 0).unwrap(), None);
    }

    #[test]
    fn del_reports_existence() {
        let st = s();
        set(&st, "a", "1").unwrap();
        assert!(del(&st, "a").unwrap());
        assert!(!del(&st, "a").unwrap());
    }

    #[test]
    fn mget_preserves_order() {
        let st = s();
        set(&st, "a", "1").unwrap();
        set(&st, "c", "3").unwrap();
        let got = mget(&st, &["a".into(), "b".into(), "c".into()], 0).unwrap();
        assert_eq!(got, vec![Some("1".into()), None, Some("3".into())]);
    }

    #[test]
    fn hash_ops() {
        let st = s();
        hset(&st, "h", "f1", "v1").unwrap();
        hset(&st, "h", "f2", "v2").unwrap();
        assert_eq!(hget(&st, "h", "f1", 0).unwrap(), Some("v1".into()));
        let all = hgetall(&st, "h", 0).unwrap();
        assert_eq!(all.len(), 2);
        assert_eq!(all["f2"], "v2");
    }

    #[test]
    fn ttl_expires_lazily() {
        let st = s();
        set(&st, "a", "1").unwrap();
        expire(&st, "a", 1000, 0).unwrap();
        assert_eq!(ttl(&st, "a", 500).unwrap(), Some(500));
        assert_eq!(get(&st, "a", 999).unwrap(), Some("1".into()));
        assert_eq!(get(&st, "a", 1000).unwrap(), None);
        // key row physically removed after expiry read
        let n: i64 = st
            .conn
            .query_row("SELECT count(*) FROM kv WHERE key='a'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0);
    }

    #[test]
    fn ttl_applies_to_hashes() {
        let st = s();
        hset(&st, "h", "f", "v").unwrap();
        expire(&st, "h", 10, 0).unwrap();
        assert!(hgetall(&st, "h", 11).unwrap().is_empty());
    }

    #[test]
    fn scan_matches_glob() {
        let st = s();
        set(&st, "user:1", "a").unwrap();
        set(&st, "user:2", "b").unwrap();
        hset(&st, "cfg:app", "k", "v").unwrap();
        let mut keys = scan(&st, "user:*", 0).unwrap();
        keys.sort();
        assert_eq!(keys, vec!["user:1", "user:2"]);
        assert_eq!(scan(&st, "*", 0).unwrap().len(), 3);
    }

    #[test]
    fn reserved_prefixes_are_write_protected() {
        let st = s();
        assert!(matches!(
            set(&st, "entry:people:x", "v"),
            Err(crate::error::EngineError::Command(_))
        ));
        assert!(matches!(
            hset(&st, "meta:api", "f", "v"),
            Err(crate::error::EngineError::Command(_))
        ));
        assert!(matches!(
            del(&st, "idx:people"),
            Err(crate::error::EngineError::Command(_))
        ));
    }

    #[test]
    fn reset_after_expiry_survives() {
        let st = s();
        set(&st, "a", "1").unwrap();
        expire(&st, "a", 10, 0).unwrap();
        // time passes well past expiry, but nothing reads the key in between
        set(&st, "a", "2").unwrap();
        assert_eq!(get(&st, "a", 1_000).unwrap(), Some("2".into()));
    }

    #[test]
    fn hset_after_expiry_survives() {
        let st = s();
        hset(&st, "h", "f", "1").unwrap();
        expire(&st, "h", 10, 0).unwrap();
        // time passes well past expiry, but nothing reads the key in between
        hset(&st, "h", "f", "2").unwrap();
        assert_eq!(hget(&st, "h", "f", 1_000).unwrap(), Some("2".into()));
    }

    #[test]
    fn glob_basics() {
        use crate::glob::glob_match;
        assert!(glob_match("*", "anything"));
        assert!(glob_match("user:*", "user:1"));
        assert!(!glob_match("user:*", "cfg:1"));
        assert!(glob_match("a*c", "abc"));
        assert!(glob_match("a*c", "ac"));
        assert!(!glob_match("a*c", "ab"));
    }
}
