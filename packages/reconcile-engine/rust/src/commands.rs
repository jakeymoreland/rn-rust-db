use crate::engine::Engine;
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
        .prepare_cached("SELECT expires_at FROM key_ttl WHERE key = ?1")?
        .query_row(params![key], |r| r.get(0))
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

pub fn get(engine: &mut Engine, key: &str, now_ms: i64) -> Result<Option<String>, EngineError> {
    // memory-first: TTL check, then cache hit, then cold read-through
    if let Some(&expires_at) = engine.kv.ttl.get(key) {
        if now_ms >= expires_at {
            engine.kv.map.remove(key);
            engine.kv.ttl.remove(key);
            engine.flush_kv()?; // sqlite must agree before the purge deletes rows
            purge_if_expired(&engine.store, key, now_ms)?;
            return Ok(None);
        }
    }
    if let Some(v) = engine.kv.map.get(key) {
        return Ok(Some(v.clone()));
    }
    // A cache miss cannot be pending (pending keys are always in the map), so
    // reading SQLite directly is safe without a flush.
    if purge_if_expired(&engine.store, key, now_ms)? {
        return Ok(None);
    }
    let v: Option<String> = engine
        .store
        .conn
        .prepare_cached("SELECT value FROM kv WHERE key = ?1")?
        .query_row(params![key], |r| r.get(0))
        .ok();
    if let Some(ref value) = v {
        engine.kv.map.insert(key.to_string(), value.clone());
        let expires: Option<i64> = engine
            .store
            .conn
            .prepare_cached("SELECT expires_at FROM key_ttl WHERE key = ?1")?
            .query_row(params![key], |r| r.get(0))
            .ok();
        if let Some(at) = expires {
            engine.kv.ttl.insert(key.to_string(), at);
        }
    }
    Ok(v)
}

pub fn set(engine: &mut Engine, key: &str, value: &str) -> Result<(), EngineError> {
    check_writable(key)?;
    engine.kv.map.insert(key.to_string(), value.to_string());
    // Redis SET semantics: overwriting a key clears any existing TTL. The
    // matching key_ttl row is cleared when this pending write flushes.
    engine.kv.ttl.remove(key);
    if engine.kv.coalesce {
        if let Some(&slot) = engine.kv.pending_index.get(key) {
            engine.kv.pending[slot].1 = value.to_string();
        } else {
            engine.kv.pending_index.insert(key.to_string(), engine.kv.pending.len());
            engine.kv.pending.push((key.to_string(), value.to_string()));
        }
    } else {
        engine.kv.pending.push((key.to_string(), value.to_string()));
    }
    if engine.kv.pending.len() >= engine.kv.high_water {
        engine.flush_kv()?;
    }
    Ok(())
}

pub fn del(engine: &mut Engine, key: &str) -> Result<bool, EngineError> {
    check_writable(key)?;
    engine.flush_kv()?;
    engine.kv.map.remove(key);
    engine.kv.ttl.remove(key);
    let store = &engine.store;
    let a = store.conn.execute("DELETE FROM kv WHERE key = ?1", params![key])?;
    let b = store.conn.execute("DELETE FROM hash WHERE key = ?1", params![key])?;
    store.conn.execute("DELETE FROM key_ttl WHERE key = ?1", params![key])?;
    Ok(a + b > 0)
}

pub fn mget(engine: &mut Engine, keys: &[String], now_ms: i64) -> Result<Vec<Option<String>>, EngineError> {
    keys.iter().map(|k| get(engine, k, now_ms)).collect()
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
        .prepare_cached("SELECT value FROM hash WHERE key = ?1 AND field = ?2")?
        .query_row(params![key, field], |r| r.get(0))
        .ok())
}

pub fn hgetall(store: &Store, key: &str, now_ms: i64) -> Result<BTreeMap<String, String>, EngineError> {
    if let Some(rest) = key.strip_prefix("entry:") {
        if let Some((collection, natural_key)) = rest.split_once(':') {
            let row: Option<(String, i64)> = store
                .conn
                .prepare_cached(
                    "SELECT fields, updated_at FROM entries WHERE collection = ?1 AND natural_key = ?2",
                )?
                .query_row(params![collection, natural_key], |r| Ok((r.get(0)?, r.get(1)?)))
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
        .prepare_cached("SELECT field, value FROM hash WHERE key = ?1")?;
    let rows = stmt.query_map(params![key], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
    let mut out = BTreeMap::new();
    for row in rows {
        let (f, v) = row?;
        out.insert(f, v);
    }
    Ok(out)
}

pub fn scan(engine: &mut Engine, pattern: &str, now_ms: i64) -> Result<Vec<String>, EngineError> {
    engine.flush_kv()?; // pending sets must be visible to the table scan
    let store = &engine.store;
    let mut keys: Vec<String> = Vec::new();
    let mut stmt = store.conn.prepare_cached(
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

pub fn expire(engine: &mut Engine, key: &str, ttl_ms: i64, now_ms: i64) -> Result<(), EngineError> {
    check_writable(key)?;
    engine.flush_kv()?; // the key may only exist as a pending set
    let store = &engine.store;
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
    if engine.kv.map.contains_key(key) {
        engine.kv.ttl.insert(key.to_string(), now_ms + ttl_ms);
    }
    Ok(())
}

pub fn ttl(engine: &mut Engine, key: &str, now_ms: i64) -> Result<Option<i64>, EngineError> {
    engine.flush_kv()?; // a pending set logically cleared any earlier TTL row
    if purge_if_expired(&engine.store, key, now_ms)? {
        engine.kv.map.remove(key);
        engine.kv.ttl.remove(key);
        return Ok(None);
    }
    let expires: Option<i64> = engine
        .store
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
    use crate::engine::Engine;

    fn e() -> Engine {
        Engine::open(":memory:", Box::new(|| 0)).unwrap()
    }

    #[test]
    fn set_get_roundtrip() {
        let mut en = e();
        set(&mut en, "a", "1").unwrap();
        assert_eq!(get(&mut en, "a", 0).unwrap(), Some("1".into()));
        assert_eq!(get(&mut en, "missing", 0).unwrap(), None);
    }

    #[test]
    fn del_reports_existence() {
        let mut en = e();
        set(&mut en, "a", "1").unwrap();
        assert!(del(&mut en, "a").unwrap());
        assert!(!del(&mut en, "a").unwrap());
        assert_eq!(get(&mut en, "a", 0).unwrap(), None);
    }

    #[test]
    fn mget_preserves_order() {
        let mut en = e();
        set(&mut en, "a", "1").unwrap();
        set(&mut en, "c", "3").unwrap();
        let got = mget(&mut en, &["a".into(), "b".into(), "c".into()], 0).unwrap();
        assert_eq!(got, vec![Some("1".into()), None, Some("3".into())]);
    }

    #[test]
    fn hash_ops() {
        let en = e();
        hset(&en.store, "h", "f1", "v1").unwrap();
        hset(&en.store, "h", "f2", "v2").unwrap();
        assert_eq!(hget(&en.store, "h", "f1", 0).unwrap(), Some("v1".into()));
        let all = hgetall(&en.store, "h", 0).unwrap();
        assert_eq!(all.len(), 2);
        assert_eq!(all["f2"], "v2");
    }

    #[test]
    fn ttl_expires_lazily() {
        let mut en = e();
        set(&mut en, "a", "1").unwrap();
        expire(&mut en, "a", 1000, 0).unwrap();
        assert_eq!(ttl(&mut en, "a", 500).unwrap(), Some(500));
        assert_eq!(get(&mut en, "a", 999).unwrap(), Some("1".into()));
        assert_eq!(get(&mut en, "a", 1000).unwrap(), None);
        // key row physically removed after expiry read
        let n: i64 = en
            .store
            .conn
            .query_row("SELECT count(*) FROM kv WHERE key='a'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0);
    }

    #[test]
    fn ttl_applies_to_hashes() {
        let mut en = e();
        hset(&en.store, "h", "f", "v").unwrap();
        expire(&mut en, "h", 10, 0).unwrap();
        assert!(hgetall(&en.store, "h", 11).unwrap().is_empty());
    }

    #[test]
    fn scan_matches_glob() {
        let mut en = e();
        set(&mut en, "user:1", "a").unwrap();
        set(&mut en, "user:2", "b").unwrap();
        hset(&en.store, "cfg:app", "k", "v").unwrap();
        let mut keys = scan(&mut en, "user:*", 0).unwrap();
        keys.sort();
        assert_eq!(keys, vec!["user:1", "user:2"]);
        assert_eq!(scan(&mut en, "*", 0).unwrap().len(), 3);
    }

    #[test]
    fn set_is_write_behind_until_flushed() {
        let mut en = e();
        set(&mut en, "wb", "v", ).unwrap();
        // not yet in SQLite...
        let n: i64 = en
            .store
            .conn
            .query_row("SELECT count(*) FROM kv WHERE key='wb'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0);
        // ...but reads see it, and a flush persists it
        assert_eq!(get(&mut en, "wb", 0).unwrap(), Some("v".into()));
        en.flush_kv().unwrap();
        let n: i64 = en
            .store
            .conn
            .query_row("SELECT count(*) FROM kv WHERE key='wb'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1);
        assert!(en.kv.pending.is_empty());
    }

    #[test]
    fn set_after_expire_clears_ttl_even_when_flushed_later() {
        let mut en = e();
        set(&mut en, "k", "v1").unwrap();
        expire(&mut en, "k", 100, 0).unwrap(); // flushes v1, sets TTL
        set(&mut en, "k", "v2").unwrap(); // pending; clears TTL per redis SET
        en.flush_kv().unwrap();
        // well past the old expiry: value must survive because SET cleared it
        assert_eq!(get(&mut en, "k", 10_000).unwrap(), Some("v2".into()));
        assert_eq!(ttl(&mut en, "k", 10_000).unwrap(), None);
    }

    #[test]
    fn cold_read_through_fills_cache_and_honors_ttl() {
        let mut en = e();
        set(&mut en, "cold", "v").unwrap();
        expire(&mut en, "cold", 50, 0).unwrap();
        en.flush_kv().unwrap();
        // simulate a fresh session: empty cache, data only in SQLite
        en.kv.map.clear();
        en.kv.ttl.clear();
        assert_eq!(get(&mut en, "cold", 10).unwrap(), Some("v".into()));
        // the fill must carry the TTL so the cached value still expires
        assert_eq!(get(&mut en, "cold", 51).unwrap(), None);
    }

    #[test]
    fn reserved_prefixes_are_write_protected() {
        let mut en = e();
        assert!(matches!(
            set(&mut en, "entry:people:x", "v"),
            Err(crate::error::EngineError::Command(_))
        ));
        assert!(matches!(
            hset(&en.store, "meta:api", "f", "v"),
            Err(crate::error::EngineError::Command(_))
        ));
        assert!(matches!(
            del(&mut en, "idx:people"),
            Err(crate::error::EngineError::Command(_))
        ));
    }

    #[test]
    fn reset_after_expiry_survives() {
        let mut en = e();
        set(&mut en, "a", "1").unwrap();
        expire(&mut en, "a", 10, 0).unwrap();
        // time passes well past expiry, but nothing reads the key in between
        set(&mut en, "a", "2").unwrap();
        assert_eq!(get(&mut en, "a", 1_000).unwrap(), Some("2".into()));
    }

    #[test]
    fn hset_after_expiry_survives() {
        let en = e();
        hset(&en.store, "h", "f", "1").unwrap();
        // hash-only key: expire via the engine wrapper
        let mut en = en;
        expire(&mut en, "h", 10, 0).unwrap();
        // time passes well past expiry, but nothing reads the key in between
        hset(&en.store, "h", "f", "2").unwrap();
        assert_eq!(hget(&en.store, "h", "f", 1_000).unwrap(), Some("2".into()));
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
