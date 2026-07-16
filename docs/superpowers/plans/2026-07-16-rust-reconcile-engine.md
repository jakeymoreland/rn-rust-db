# Rust Reconcile Engine (Raw Turbo Module) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Redis-esque, Rust-owned SQLite engine exposed to React Native through a fully hand-rolled C++ Turbo Module (no bridging-framework deps), plus an Expo dev-client sandbox with a benchmark/assessment screen.

**Architecture:** Rust crate (rusqlite/WAL, normalize→reconcile pipeline, Redis-style command dispatch over a JSON envelope, pub/sub) → hand-written C ABI header → C++ Turbo Module (codegen spec + background worker thread + manually installed JSI fast-path functions) → Expo bare-workflow sandbox app that registers the module per official pure-C++ TM docs.

**Tech Stack:** Rust (rusqlite bundled, serde, serde_json only), C++17 JSI/TurboModule, React Native new architecture (0.76+ / whatever current Expo ships), Expo + expo-dev-client, yarn workspaces.

## Global Constraints

- No bridging-framework dependencies: no uniffi, no nitro, no react-native-builder-bob codegen beyond RN's own codegen. Rust deps limited to `rusqlite` (feature `bundled`), `serde`, `serde_json`.
- `engine.h` is hand-written (no cbindgen at runtime or build time).
- Rust owns SQLite exclusively; JS never opens the DB file.
- Reserved key prefixes `entry:`, `idx:`, `meta:`, `changes:` are read-only from JS commands.
- Git commits: plain messages, **no Claude attribution trailers**.
- All timestamps in the engine are epoch milliseconds (`i64`); the `Engine` takes an injected clock for testability.
- Module name everywhere: `NativeReconcileEngine`. Codegen library name: `ReconcileEngineSpec`. Rust crate name: `reconcile_engine`.
- TDD for all Rust tasks: failing test → run → implement → pass → commit.

---

### Task 1: Monorepo skeleton + Rust crate + error type

**Files:**
- Create: `package.json` (workspace root)
- Create: `packages/reconcile-engine/rust/Cargo.toml`
- Create: `packages/reconcile-engine/rust/src/lib.rs`
- Create: `packages/reconcile-engine/rust/src/error.rs`
- Create: `.gitignore`

**Interfaces:**
- Produces: `EngineError` enum with variants `Parse(String)`, `Storage(String)`, `Source(String)`, `Command(String)`; method `pub fn code(&self) -> u32` returning 1/2/3/4 respectively; implements `std::fmt::Display` and `From<rusqlite::Error>`.

- [ ] **Step 1: Toolchain check**

Run: `rustc --version && cargo --version`
Expected: rust 1.7x+. If missing: `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`

- [ ] **Step 2: Write root package.json and .gitignore**

`package.json`:
```json
{
  "name": "rn-experiments",
  "private": true,
  "workspaces": ["packages/*", "apps/*"]
}
```

`.gitignore`:
```
node_modules/
target/
*.log
.DS_Store
ios/Pods/
android/.gradle/
android/app/build/
build/
dist/
*.xcframework
jniLibs/
```

- [ ] **Step 3: Create crate with failing error test**

`packages/reconcile-engine/rust/Cargo.toml`:
```toml
[package]
name = "reconcile_engine"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["staticlib", "lib"]

[dependencies]
rusqlite = { version = "0.32", features = ["bundled"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
```

`packages/reconcile-engine/rust/src/lib.rs`:
```rust
pub mod error;
```

`packages/reconcile-engine/rust/src/error.rs`:
```rust
use std::fmt;

#[derive(Debug)]
pub enum EngineError {
    Parse(String),
    Storage(String),
    Source(String),
    Command(String),
}

impl EngineError {
    pub fn code(&self) -> u32 {
        match self {
            EngineError::Parse(_) => 1,
            EngineError::Storage(_) => 2,
            EngineError::Source(_) => 3,
            EngineError::Command(_) => 4,
        }
    }
}

impl fmt::Display for EngineError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            EngineError::Parse(m) => write!(f, "parse error: {m}"),
            EngineError::Storage(m) => write!(f, "storage error: {m}"),
            EngineError::Source(m) => write!(f, "source error: {m}"),
            EngineError::Command(m) => write!(f, "command error: {m}"),
        }
    }
}

impl std::error::Error for EngineError {}

impl From<rusqlite::Error> for EngineError {
    fn from(e: rusqlite::Error) -> Self {
        EngineError::Storage(e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_are_stable() {
        assert_eq!(EngineError::Parse("x".into()).code(), 1);
        assert_eq!(EngineError::Storage("x".into()).code(), 2);
        assert_eq!(EngineError::Source("x".into()).code(), 3);
        assert_eq!(EngineError::Command("x".into()).code(), 4);
    }

    #[test]
    fn display_includes_message() {
        assert_eq!(
            EngineError::Command("nope".into()).to_string(),
            "command error: nope"
        );
    }
}
```

- [ ] **Step 4: Run tests**

Run: `cargo test --manifest-path packages/reconcile-engine/rust/Cargo.toml`
Expected: 2 passed (first build compiles bundled SQLite; takes a few minutes).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "Scaffold monorepo and engine crate with error type"
```

---

### Task 2: Store — schema, migrations, WAL

**Files:**
- Create: `packages/reconcile-engine/rust/src/store.rs`
- Modify: `packages/reconcile-engine/rust/src/lib.rs`

**Interfaces:**
- Consumes: `EngineError`
- Produces: `pub struct Store { pub(crate) conn: rusqlite::Connection }` with `pub fn open(path: &str) -> Result<Store, EngineError>` (`:memory:` supported), `pub fn user_version(&self) -> Result<i64, EngineError>`. Tables: `kv(key TEXT PK, value TEXT)`, `hash(key, field, value, PK(key,field))`, `key_ttl(key TEXT PK, expires_at INTEGER)`, `entries(collection, natural_key, fields TEXT json, field_meta TEXT json, updated_at INTEGER, PK(collection,natural_key))`, `sync_meta(source TEXT PK, cursor TEXT, last_sync INTEGER, content_hash TEXT)`, `dead_letter(id INTEGER PK AUTOINCREMENT, source, fragment, error, created_at)`.

- [ ] **Step 1: Write failing tests**

`store.rs` (tests section first):
```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn open_creates_schema() {
        let store = Store::open(":memory:").unwrap();
        let count: i64 = store
            .conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type='table' AND name IN
                 ('kv','hash','key_ttl','entries','sync_meta','dead_letter')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 6);
        assert_eq!(store.user_version().unwrap(), 1);
    }

    #[test]
    fn open_is_idempotent() {
        let dir = std::env::temp_dir().join("reconcile_engine_test_idempotent");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("db.sqlite");
        let p = path.to_str().unwrap();
        drop(Store::open(p).unwrap());
        drop(Store::open(p).unwrap());
    }

    #[test]
    fn file_db_uses_wal() {
        let dir = std::env::temp_dir().join("reconcile_engine_test_wal");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let store = Store::open(dir.join("db.sqlite").to_str().unwrap()).unwrap();
        let mode: String = store
            .conn
            .query_row("PRAGMA journal_mode", [], |r| r.get(0))
            .unwrap();
        assert_eq!(mode.to_lowercase(), "wal");
    }
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test --manifest-path packages/reconcile-engine/rust/Cargo.toml store`
Expected: compile error — `Store` not defined.

- [ ] **Step 3: Implement**

Top of `store.rs`:
```rust
use crate::error::EngineError;
use rusqlite::Connection;

pub struct Store {
    pub(crate) conn: Connection,
}

const SCHEMA_V1: &str = "
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS hash (
  key TEXT NOT NULL,
  field TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (key, field)
);
CREATE TABLE IF NOT EXISTS key_ttl (
  key TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS entries (
  collection TEXT NOT NULL,
  natural_key TEXT NOT NULL,
  fields TEXT NOT NULL,
  field_meta TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (collection, natural_key)
);
CREATE TABLE IF NOT EXISTS sync_meta (
  source TEXT PRIMARY KEY,
  cursor TEXT,
  last_sync INTEGER,
  content_hash TEXT
);
CREATE TABLE IF NOT EXISTS dead_letter (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  fragment TEXT NOT NULL,
  error TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
PRAGMA user_version = 1;
";

impl Store {
    pub fn open(path: &str) -> Result<Store, EngineError> {
        let conn = Connection::open(path)?;
        if path != ":memory:" {
            let _mode: String =
                conn.query_row("PRAGMA journal_mode = WAL", [], |r| r.get(0))?;
        }
        conn.execute_batch(SCHEMA_V1)?;
        Ok(Store { conn })
    }

    pub fn user_version(&self) -> Result<i64, EngineError> {
        Ok(self.conn.query_row("PRAGMA user_version", [], |r| r.get(0))?)
    }
}
```

Add `pub mod store;` to `lib.rs`.

- [ ] **Step 4: Run tests**

Run: `cargo test --manifest-path packages/reconcile-engine/rust/Cargo.toml`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "Add store with schema v1 and WAL"
```

---

### Task 3: Redis-style commands — kv, hashes, scan, TTL

**Files:**
- Create: `packages/reconcile-engine/rust/src/commands.rs`
- Create: `packages/reconcile-engine/rust/src/glob.rs`
- Modify: `packages/reconcile-engine/rust/src/lib.rs`

**Interfaces:**
- Consumes: `Store`, `EngineError`
- Produces (all take `store: &Store` — rusqlite handles interior locking per connection — and `now_ms: i64`):
  - `pub fn get(store: &Store, key: &str, now_ms: i64) -> Result<Option<String>, EngineError>`
  - `pub fn set(store: &Store, key: &str, value: &str) -> Result<(), EngineError>`
  - `pub fn del(store: &Store, key: &str) -> Result<bool, EngineError>`
  - `pub fn mget(store: &Store, keys: &[String], now_ms: i64) -> Result<Vec<Option<String>>, EngineError>`
  - `pub fn hset(store: &Store, key: &str, field: &str, value: &str) -> Result<(), EngineError>`
  - `pub fn hget(store: &Store, key: &str, field: &str, now_ms: i64) -> Result<Option<String>, EngineError>`
  - `pub fn hgetall(store: &Store, key: &str, now_ms: i64) -> Result<std::collections::BTreeMap<String, String>, EngineError>`
  - `pub fn scan(store: &Store, pattern: &str, now_ms: i64) -> Result<Vec<String>, EngineError>` (kv + hash keys + entry virtual keys are added in Task 5)
  - `pub fn expire(store: &Store, key: &str, ttl_ms: i64, now_ms: i64) -> Result<(), EngineError>`
  - `pub fn ttl(store: &Store, key: &str, now_ms: i64) -> Result<Option<i64>, EngineError>` (remaining ms; `None` if no TTL)
  - `glob.rs`: `pub fn glob_match(pattern: &str, text: &str) -> bool` supporting `*` wildcards only.
  - `pub const RESERVED_PREFIXES: [&str; 4] = ["entry:", "idx:", "meta:", "changes:"];` — `set`/`hset`/`del`/`expire` return `EngineError::Command` for reserved keys.

**Behavior:** TTL is lazy — reads check `key_ttl`; expired keys are deleted (from `kv`, `hash`, `key_ttl`) on access and treated as absent. `expire` on a missing key is a `Command` error.

- [ ] **Step 1: Write failing tests** (in `commands.rs`)

```rust
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
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test --manifest-path packages/reconcile-engine/rust/Cargo.toml commands`
Expected: compile errors (functions not defined).

- [ ] **Step 3: Implement**

`glob.rs`:
```rust
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
```

`commands.rs`:
```rust
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
    let mut out = Vec::new();
    for k in keys {
        if glob_match(pattern, &k) && !purge_if_expired(store, &k, now_ms)? {
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
```

Add `pub mod commands; pub mod glob;` to `lib.rs`.

- [ ] **Step 4: Run tests**

Run: `cargo test --manifest-path packages/reconcile-engine/rust/Cargo.toml`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "Add redis-style kv/hash/scan/ttl commands with reserved-prefix guard"
```

---

### Task 4: Normalize — source configs, JSON + CSV parsers

**Files:**
- Create: `packages/reconcile-engine/rust/src/normalize.rs`
- Modify: `packages/reconcile-engine/rust/src/lib.rs`

**Interfaces:**
- Consumes: `EngineError`
- Produces:
```rust
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub enum SourceFormat { Json, Csv }

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct SourceConfig {
    pub source_id: String,
    pub format: SourceFormat,
    pub collection: String,
    pub natural_key_field: String,
    pub timestamp_field: Option<String>, // epoch ms integer field
    pub priority: u32,                   // higher wins ties
}

#[derive(Clone, Debug, PartialEq)]
pub struct CanonicalRecord {
    pub collection: String,
    pub natural_key: String,
    pub source: String,
    pub fields: std::collections::BTreeMap<String, String>,
    pub updated_at: i64,
}

pub struct NormalizeOutcome {
    pub records: Vec<CanonicalRecord>,
    pub rejects: Vec<(String, String)>, // (fragment, error message)
}

pub fn normalize(cfg: &SourceConfig, payload: &str, now_ms: i64)
    -> Result<NormalizeOutcome, EngineError>;
```
- JSON payloads: top-level array of objects. Non-object elements and objects missing the natural key field become rejects (fragment = element JSON), not batch failures. A non-array top level is `EngineError::Parse`.
- CSV payloads: first row is the header; RFC-4180 subset (quoted fields with `""` escapes, `\n`/`\r\n` row separators, no embedded newlines needed beyond quoted fields). Rows with wrong column count or missing natural key are rejects.
- All field values stored as strings (JSON numbers/bools stringified via `to_string()`; JSON strings unwrapped). `updated_at` from `timestamp_field` if present and parseable as i64, else `now_ms`.

- [ ] **Step 1: Write failing tests** (in `normalize.rs`)

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn json_cfg() -> SourceConfig {
        SourceConfig {
            source_id: "api".into(),
            format: SourceFormat::Json,
            collection: "people".into(),
            natural_key_field: "email".into(),
            timestamp_field: Some("updatedAt".into()),
            priority: 10,
        }
    }

    fn csv_cfg() -> SourceConfig {
        SourceConfig {
            source_id: "csv".into(),
            format: SourceFormat::Csv,
            collection: "people".into(),
            natural_key_field: "email".into(),
            timestamp_field: None,
            priority: 5,
        }
    }

    #[test]
    fn json_happy_path() {
        let payload = r#"[
            {"email":"a@x.com","name":"Ann","age":30,"updatedAt":1000},
            {"email":"b@x.com","name":"Bob","active":true,"updatedAt":2000}
        ]"#;
        let out = normalize(&json_cfg(), payload, 99).unwrap();
        assert_eq!(out.records.len(), 2);
        assert!(out.rejects.is_empty());
        let r = &out.records[0];
        assert_eq!(r.collection, "people");
        assert_eq!(r.natural_key, "a@x.com");
        assert_eq!(r.source, "api");
        assert_eq!(r.fields["name"], "Ann");
        assert_eq!(r.fields["age"], "30");
        assert_eq!(r.updated_at, 1000);
        assert_eq!(out.records[1].fields["active"], "true");
    }

    #[test]
    fn json_missing_key_is_reject_not_failure() {
        let payload = r#"[{"name":"NoKey"},{"email":"ok@x.com","name":"Ok"}]"#;
        let out = normalize(&json_cfg(), payload, 42).unwrap();
        assert_eq!(out.records.len(), 1);
        assert_eq!(out.rejects.len(), 1);
        assert!(out.rejects[0].1.contains("email"));
        // no timestamp field on the good record -> falls back to now_ms
        assert_eq!(out.records[0].updated_at, 42);
    }

    #[test]
    fn json_non_array_is_parse_error() {
        assert!(matches!(
            normalize(&json_cfg(), r#"{"not":"array"}"#, 0),
            Err(crate::error::EngineError::Parse(_))
        ));
    }

    #[test]
    fn csv_happy_path_with_quotes() {
        let payload = "email,name,notes\na@x.com,Ann,\"likes, commas\"\nb@x.com,Bob,\"say \"\"hi\"\"\"\n";
        let out = normalize(&csv_cfg(), payload, 7).unwrap();
        assert_eq!(out.records.len(), 2);
        assert_eq!(out.records[0].fields["notes"], "likes, commas");
        assert_eq!(out.records[1].fields["notes"], "say \"hi\"");
        assert_eq!(out.records[0].updated_at, 7);
    }

    #[test]
    fn csv_bad_rows_are_rejects() {
        let payload = "email,name\na@x.com,Ann\nonly-one-column\n,MissingEmail\n";
        let out = normalize(&csv_cfg(), payload, 0).unwrap();
        assert_eq!(out.records.len(), 1);
        assert_eq!(out.rejects.len(), 2);
    }
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test --manifest-path packages/reconcile-engine/rust/Cargo.toml normalize`
Expected: compile errors.

- [ ] **Step 3: Implement**

```rust
use crate::error::EngineError;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub enum SourceFormat {
    Json,
    Csv,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SourceConfig {
    pub source_id: String,
    pub format: SourceFormat,
    pub collection: String,
    pub natural_key_field: String,
    pub timestamp_field: Option<String>,
    pub priority: u32,
}

#[derive(Clone, Debug, PartialEq)]
pub struct CanonicalRecord {
    pub collection: String,
    pub natural_key: String,
    pub source: String,
    pub fields: BTreeMap<String, String>,
    pub updated_at: i64,
}

pub struct NormalizeOutcome {
    pub records: Vec<CanonicalRecord>,
    pub rejects: Vec<(String, String)>,
}

pub fn normalize(
    cfg: &SourceConfig,
    payload: &str,
    now_ms: i64,
) -> Result<NormalizeOutcome, EngineError> {
    match cfg.format {
        SourceFormat::Json => normalize_json(cfg, payload, now_ms),
        SourceFormat::Csv => normalize_csv(cfg, payload, now_ms),
    }
}

fn value_to_string(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

fn build_record(
    cfg: &SourceConfig,
    fields: BTreeMap<String, String>,
    fragment: &str,
    now_ms: i64,
) -> Result<CanonicalRecord, (String, String)> {
    let natural_key = match fields.get(&cfg.natural_key_field) {
        Some(k) if !k.is_empty() => k.clone(),
        _ => {
            return Err((
                fragment.to_string(),
                format!("missing natural key field '{}'", cfg.natural_key_field),
            ))
        }
    };
    let updated_at = cfg
        .timestamp_field
        .as_ref()
        .and_then(|tf| fields.get(tf))
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(now_ms);
    Ok(CanonicalRecord {
        collection: cfg.collection.clone(),
        natural_key,
        source: cfg.source_id.clone(),
        fields,
        updated_at,
    })
}

fn normalize_json(
    cfg: &SourceConfig,
    payload: &str,
    now_ms: i64,
) -> Result<NormalizeOutcome, EngineError> {
    let parsed: serde_json::Value = serde_json::from_str(payload)
        .map_err(|e| EngineError::Parse(e.to_string()))?;
    let arr = parsed
        .as_array()
        .ok_or_else(|| EngineError::Parse("expected top-level JSON array".into()))?;
    let mut out = NormalizeOutcome { records: vec![], rejects: vec![] };
    for item in arr {
        let fragment = item.to_string();
        let obj = match item.as_object() {
            Some(o) => o,
            None => {
                out.rejects.push((fragment, "expected JSON object".into()));
                continue;
            }
        };
        let fields: BTreeMap<String, String> = obj
            .iter()
            .map(|(k, v)| (k.clone(), value_to_string(v)))
            .collect();
        match build_record(cfg, fields, &fragment, now_ms) {
            Ok(r) => out.records.push(r),
            Err(rej) => out.rejects.push(rej),
        }
    }
    Ok(out)
}

/// Minimal RFC-4180 subset parser: quoted fields, "" escapes, \r\n or \n rows.
fn parse_csv_rows(payload: &str) -> Vec<Vec<String>> {
    let mut rows: Vec<Vec<String>> = Vec::new();
    let mut row: Vec<String> = Vec::new();
    let mut field = String::new();
    let mut in_quotes = false;
    let mut chars = payload.chars().peekable();
    while let Some(c) = chars.next() {
        if in_quotes {
            match c {
                '"' => {
                    if chars.peek() == Some(&'"') {
                        chars.next();
                        field.push('"');
                    } else {
                        in_quotes = false;
                    }
                }
                _ => field.push(c),
            }
        } else {
            match c {
                '"' => in_quotes = true,
                ',' => {
                    row.push(std::mem::take(&mut field));
                }
                '\r' => {}
                '\n' => {
                    row.push(std::mem::take(&mut field));
                    rows.push(std::mem::take(&mut row));
                }
                _ => field.push(c),
            }
        }
    }
    if !field.is_empty() || !row.is_empty() {
        row.push(field);
        rows.push(row);
    }
    rows
}

fn normalize_csv(
    cfg: &SourceConfig,
    payload: &str,
    now_ms: i64,
) -> Result<NormalizeOutcome, EngineError> {
    let rows = parse_csv_rows(payload);
    if rows.is_empty() {
        return Err(EngineError::Parse("empty CSV payload".into()));
    }
    let header = &rows[0];
    let mut out = NormalizeOutcome { records: vec![], rejects: vec![] };
    for row in &rows[1..] {
        let fragment = row.join(",");
        if row.len() != header.len() {
            out.rejects.push((
                fragment,
                format!("expected {} columns, got {}", header.len(), row.len()),
            ));
            continue;
        }
        let fields: BTreeMap<String, String> = header
            .iter()
            .cloned()
            .zip(row.iter().cloned())
            .collect();
        match build_record(cfg, fields, &fragment, now_ms) {
            Ok(r) => out.records.push(r),
            Err(rej) => out.rejects.push(rej),
        }
    }
    Ok(out)
}
```

Add `pub mod normalize;` to `lib.rs`.

- [ ] **Step 4: Run tests**

Run: `cargo test --manifest-path packages/reconcile-engine/rust/Cargo.toml`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "Add normalize with source configs, JSON and CSV parsers"
```

---

### Task 5: Reconcile — per-field LWW merge, dead letter, entry read surface

**Files:**
- Create: `packages/reconcile-engine/rust/src/reconcile.rs`
- Modify: `packages/reconcile-engine/rust/src/commands.rs` (entry virtual keys in `hgetall`/`scan`)
- Modify: `packages/reconcile-engine/rust/src/lib.rs`

**Interfaces:**
- Consumes: `Store`, `CanonicalRecord`, `SourceConfig`, `NormalizeOutcome`
- Produces:
```rust
#[derive(Debug, serde::Serialize, PartialEq)]
pub struct BatchSummary {
    pub inserted: u32,
    pub updated: u32,
    pub unchanged: u32,
    pub dead_lettered: u32,
    pub collections: Vec<String>, // collections that actually changed
}

pub fn reconcile(store: &mut Store, cfg: &SourceConfig, outcome: NormalizeOutcome, now_ms: i64)
    -> Result<BatchSummary, EngineError>;
```
- `field_meta` column stores JSON: `{ "<field>": {"source": "...", "updated_at": 123, "priority": 10} }`.
- Merge rule per field: incoming wins iff `updated_at > existing.updated_at`, or equal timestamps and `priority > existing.priority`. New fields always land.
- Rejects → `dead_letter` rows. All work in ONE transaction.
- Entry read surface (in `commands.rs`): `hgetall` on `entry:{collection}:{natural_key}` reads the entries table and returns fields plus synthetic `_updated_at`; `scan` results include `entry:{collection}:{natural_key}` virtual keys.

- [ ] **Step 1: Write failing tests** (in `reconcile.rs`)

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::normalize::{CanonicalRecord, NormalizeOutcome, SourceConfig, SourceFormat};
    use crate::store::Store;
    use std::collections::BTreeMap;

    fn cfg(source: &str, priority: u32) -> SourceConfig {
        SourceConfig {
            source_id: source.into(),
            format: SourceFormat::Json,
            collection: "people".into(),
            natural_key_field: "email".into(),
            timestamp_field: None,
            priority,
        }
    }

    fn rec(source: &str, key: &str, field: &str, value: &str, ts: i64) -> CanonicalRecord {
        let mut fields = BTreeMap::new();
        fields.insert("email".into(), key.into());
        fields.insert(field.into(), value.into());
        CanonicalRecord {
            collection: "people".into(),
            natural_key: key.into(),
            source: source.into(),
            fields,
            updated_at: ts,
        }
    }

    fn outcome(records: Vec<CanonicalRecord>) -> NormalizeOutcome {
        NormalizeOutcome { records, rejects: vec![] }
    }

    #[test]
    fn insert_then_read_via_redis_surface() {
        let mut st = Store::open(":memory:").unwrap();
        let s = reconcile(&mut st, &cfg("api", 10), outcome(vec![rec("api", "a@x.com", "name", "Ann", 100)]), 0).unwrap();
        assert_eq!(s.inserted, 1);
        assert_eq!(s.collections, vec!["people".to_string()]);
        let h = crate::commands::hgetall(&st, "entry:people:a@x.com", 0).unwrap();
        assert_eq!(h["name"], "Ann");
        assert_eq!(h["_updated_at"], "100");
    }

    #[test]
    fn newer_timestamp_wins_per_field() {
        let mut st = Store::open(":memory:").unwrap();
        reconcile(&mut st, &cfg("api", 10), outcome(vec![rec("api", "a@x.com", "name", "Ann", 100)]), 0).unwrap();
        let s = reconcile(&mut st, &cfg("csv", 5), outcome(vec![rec("csv", "a@x.com", "name", "Annie", 200)]), 0).unwrap();
        assert_eq!(s.updated, 1);
        let h = crate::commands::hgetall(&st, "entry:people:a@x.com", 0).unwrap();
        assert_eq!(h["name"], "Annie");
    }

    #[test]
    fn older_timestamp_loses_higher_priority_ties_win() {
        let mut st = Store::open(":memory:").unwrap();
        reconcile(&mut st, &cfg("api", 10), outcome(vec![rec("api", "a@x.com", "name", "Ann", 100)]), 0).unwrap();
        // older -> loses
        let s1 = reconcile(&mut st, &cfg("csv", 99), outcome(vec![rec("csv", "a@x.com", "name", "Old", 50)]), 0).unwrap();
        assert_eq!(s1.unchanged, 1);
        // same ts, higher priority -> wins
        reconcile(&mut st, &cfg("dev", 20), outcome(vec![rec("dev", "a@x.com", "name", "Tie", 100)]), 0).unwrap();
        let h = crate::commands::hgetall(&st, "entry:people:a@x.com", 0).unwrap();
        assert_eq!(h["name"], "Tie");
    }

    #[test]
    fn fields_merge_across_sources() {
        let mut st = Store::open(":memory:").unwrap();
        reconcile(&mut st, &cfg("api", 10), outcome(vec![rec("api", "a@x.com", "name", "Ann", 100)]), 0).unwrap();
        reconcile(&mut st, &cfg("csv", 5), outcome(vec![rec("csv", "a@x.com", "phone", "555", 100)]), 0).unwrap();
        let h = crate::commands::hgetall(&st, "entry:people:a@x.com", 0).unwrap();
        assert_eq!(h["name"], "Ann");
        assert_eq!(h["phone"], "555");
    }

    #[test]
    fn rejects_go_to_dead_letter_batch_still_commits() {
        let mut st = Store::open(":memory:").unwrap();
        let out = NormalizeOutcome {
            records: vec![rec("api", "a@x.com", "name", "Ann", 100)],
            rejects: vec![("{bad}".into(), "missing email".into())],
        };
        let s = reconcile(&mut st, &cfg("api", 10), out, 123).unwrap();
        assert_eq!(s.inserted, 1);
        assert_eq!(s.dead_lettered, 1);
        let n: i64 = st.conn.query_row("SELECT count(*) FROM dead_letter", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
    }

    #[test]
    fn identical_reingest_is_unchanged() {
        let mut st = Store::open(":memory:").unwrap();
        reconcile(&mut st, &cfg("api", 10), outcome(vec![rec("api", "a@x.com", "name", "Ann", 100)]), 0).unwrap();
        let s = reconcile(&mut st, &cfg("api", 10), outcome(vec![rec("api", "a@x.com", "name", "Ann", 100)]), 0).unwrap();
        assert_eq!(s.unchanged, 1);
        assert!(s.collections.is_empty());
    }

    #[test]
    fn scan_sees_entry_virtual_keys() {
        let mut st = Store::open(":memory:").unwrap();
        reconcile(&mut st, &cfg("api", 10), outcome(vec![rec("api", "a@x.com", "name", "Ann", 100)]), 0).unwrap();
        let keys = crate::commands::scan(&st, "entry:people:*", 0).unwrap();
        assert_eq!(keys, vec!["entry:people:a@x.com"]);
    }
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test --manifest-path packages/reconcile-engine/rust/Cargo.toml reconcile`
Expected: compile errors.

- [ ] **Step 3: Implement `reconcile.rs`**

```rust
use crate::error::EngineError;
use crate::normalize::{NormalizeOutcome, SourceConfig};
use crate::store::Store;
use rusqlite::params;
use serde::Serialize;
use std::collections::BTreeMap;

#[derive(Debug, Serialize, PartialEq)]
pub struct BatchSummary {
    pub inserted: u32,
    pub updated: u32,
    pub unchanged: u32,
    pub dead_lettered: u32,
    pub collections: Vec<String>,
}

#[derive(Serialize, serde::Deserialize, Clone)]
struct FieldMeta {
    source: String,
    updated_at: i64,
    priority: u32,
}

pub fn reconcile(
    store: &mut Store,
    cfg: &SourceConfig,
    outcome: NormalizeOutcome,
    now_ms: i64,
) -> Result<BatchSummary, EngineError> {
    let tx = store.conn.transaction()?;
    let mut summary = BatchSummary {
        inserted: 0,
        updated: 0,
        unchanged: 0,
        dead_lettered: 0,
        collections: vec![],
    };
    let mut changed_collections: Vec<String> = vec![];

    for rec in outcome.records {
        let existing: Option<(String, String)> = tx
            .query_row(
                "SELECT fields, field_meta FROM entries WHERE collection = ?1 AND natural_key = ?2",
                params![rec.collection, rec.natural_key],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .ok();

        match existing {
            None => {
                let meta: BTreeMap<String, FieldMeta> = rec
                    .fields
                    .keys()
                    .map(|k| {
                        (
                            k.clone(),
                            FieldMeta {
                                source: rec.source.clone(),
                                updated_at: rec.updated_at,
                                priority: cfg.priority,
                            },
                        )
                    })
                    .collect();
                tx.execute(
                    "INSERT INTO entries(collection, natural_key, fields, field_meta, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![
                        rec.collection,
                        rec.natural_key,
                        serde_json::to_string(&rec.fields).unwrap(),
                        serde_json::to_string(&meta).unwrap(),
                        rec.updated_at
                    ],
                )?;
                summary.inserted += 1;
                changed_collections.push(rec.collection.clone());
            }
            Some((fields_json, meta_json)) => {
                let mut fields: BTreeMap<String, String> =
                    serde_json::from_str(&fields_json)
                        .map_err(|e| EngineError::Storage(e.to_string()))?;
                let mut meta: BTreeMap<String, FieldMeta> =
                    serde_json::from_str(&meta_json)
                        .map_err(|e| EngineError::Storage(e.to_string()))?;
                let mut dirty = false;
                for (k, v) in &rec.fields {
                    let wins = match meta.get(k) {
                        None => true,
                        Some(m) => {
                            rec.updated_at > m.updated_at
                                || (rec.updated_at == m.updated_at && cfg.priority > m.priority)
                        }
                    };
                    if wins && fields.get(k) != Some(v) {
                        fields.insert(k.clone(), v.clone());
                        dirty = true;
                    }
                    if wins {
                        meta.insert(
                            k.clone(),
                            FieldMeta {
                                source: rec.source.clone(),
                                updated_at: rec.updated_at,
                                priority: cfg.priority,
                            },
                        );
                    }
                }
                if dirty {
                    tx.execute(
                        "UPDATE entries SET fields = ?3, field_meta = ?4, updated_at = ?5
                         WHERE collection = ?1 AND natural_key = ?2",
                        params![
                            rec.collection,
                            rec.natural_key,
                            serde_json::to_string(&fields).unwrap(),
                            serde_json::to_string(&meta).unwrap(),
                            rec.updated_at.max(0)
                        ],
                    )?;
                    summary.updated += 1;
                    changed_collections.push(rec.collection.clone());
                } else {
                    summary.unchanged += 1;
                }
            }
        }
    }

    for (fragment, error) in outcome.rejects {
        tx.execute(
            "INSERT INTO dead_letter(source, fragment, error, created_at) VALUES (?1, ?2, ?3, ?4)",
            params![cfg.source_id, fragment, error, now_ms],
        )?;
        summary.dead_lettered += 1;
    }

    tx.execute(
        "INSERT INTO sync_meta(source, last_sync) VALUES (?1, ?2)
         ON CONFLICT(source) DO UPDATE SET last_sync = excluded.last_sync",
        params![cfg.source_id, now_ms],
    )?;

    tx.commit()?;
    changed_collections.sort();
    changed_collections.dedup();
    summary.collections = changed_collections;
    Ok(summary)
}
```

- [ ] **Step 4: Extend `commands.rs` for entry virtual keys**

In `hgetall`, before the hash lookup, add:
```rust
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
```

In `scan`, after collecting kv/hash keys, add entry virtual keys:
```rust
    let mut stmt2 = store
        .conn
        .prepare("SELECT collection, natural_key FROM entries")?;
    let rows2 = stmt2.query_map([], |r| {
        Ok(format!("entry:{}:{}", r.get::<_, String>(0)?, r.get::<_, String>(1)?))
    })?;
    for row in rows2 {
        keys.push(row?);
    }
```
(Entry keys skip `purge_if_expired` — reconciled entries never expire; guard the purge call with `!k.starts_with("entry:")`.)

Add `pub mod reconcile;` to `lib.rs`.

- [ ] **Step 5: Run all tests**

Run: `cargo test --manifest-path packages/reconcile-engine/rust/Cargo.toml`
Expected: all pass (including Task 3 tests still green).

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "Add reconcile with per-field LWW merge, dead letter, entry read surface"
```

---

### Task 6: Pub/sub

**Files:**
- Create: `packages/reconcile-engine/rust/src/pubsub.rs`
- Modify: `packages/reconcile-engine/rust/src/lib.rs`

**Interfaces:**
- Consumes: `glob_match`
- Produces:
```rust
pub type Sink = Box<dyn Fn(&str, &str) + Send>; // (channel, payload_json)

pub struct PubSub { /* private */ }

impl PubSub {
    pub fn new() -> PubSub;
    pub fn set_sink(&mut self, sink: Sink);
    pub fn subscribe(&mut self, pattern: &str) -> u64;      // returns subscription id
    pub fn unsubscribe(&mut self, id: u64) -> bool;
    pub fn publish(&self, channel: &str, payload: &str) -> u32; // # matching subs; calls sink once if >=1 match
}
```

- [ ] **Step 1: Write failing tests** (in `pubsub.rs`)

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    fn recording_pubsub() -> (PubSub, Arc<Mutex<Vec<(String, String)>>>) {
        let mut ps = PubSub::new();
        let log: Arc<Mutex<Vec<(String, String)>>> = Arc::new(Mutex::new(vec![]));
        let l2 = log.clone();
        ps.set_sink(Box::new(move |ch, payload| {
            l2.lock().unwrap().push((ch.to_string(), payload.to_string()));
        }));
        (ps, log)
    }

    #[test]
    fn publish_reaches_matching_pattern_once() {
        let (mut ps, log) = recording_pubsub();
        ps.subscribe("changes:*");
        ps.subscribe("changes:people"); // second match must not double-fire sink
        let n = ps.publish("changes:people", "{}");
        assert_eq!(n, 2);
        assert_eq!(log.lock().unwrap().len(), 1);
        assert_eq!(log.lock().unwrap()[0].0, "changes:people");
    }

    #[test]
    fn no_match_no_sink() {
        let (mut ps, log) = recording_pubsub();
        ps.subscribe("changes:people");
        assert_eq!(ps.publish("changes:orders", "{}"), 0);
        assert!(log.lock().unwrap().is_empty());
    }

    #[test]
    fn unsubscribe_stops_delivery() {
        let (mut ps, log) = recording_pubsub();
        let id = ps.subscribe("changes:*");
        assert!(ps.unsubscribe(id));
        assert!(!ps.unsubscribe(id));
        ps.publish("changes:people", "{}");
        assert!(log.lock().unwrap().is_empty());
    }
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test --manifest-path packages/reconcile-engine/rust/Cargo.toml pubsub`
Expected: compile errors.

- [ ] **Step 3: Implement**

```rust
use crate::glob::glob_match;

pub type Sink = Box<dyn Fn(&str, &str) + Send>;

struct Sub {
    id: u64,
    pattern: String,
}

pub struct PubSub {
    subs: Vec<Sub>,
    next_id: u64,
    sink: Option<Sink>,
}

impl PubSub {
    pub fn new() -> PubSub {
        PubSub { subs: vec![], next_id: 1, sink: None }
    }

    pub fn set_sink(&mut self, sink: Sink) {
        self.sink = Some(sink);
    }

    pub fn subscribe(&mut self, pattern: &str) -> u64 {
        let id = self.next_id;
        self.next_id += 1;
        self.subs.push(Sub { id, pattern: pattern.to_string() });
        id
    }

    pub fn unsubscribe(&mut self, id: u64) -> bool {
        let before = self.subs.len();
        self.subs.retain(|s| s.id != id);
        self.subs.len() != before
    }

    pub fn publish(&self, channel: &str, payload: &str) -> u32 {
        let matches = self
            .subs
            .iter()
            .filter(|s| glob_match(&s.pattern, channel))
            .count() as u32;
        if matches > 0 {
            if let Some(sink) = &self.sink {
                sink(channel, payload);
            }
        }
        matches
    }
}
```

Add `pub mod pubsub;` to `lib.rs`.

- [ ] **Step 4: Run tests**

Run: `cargo test --manifest-path packages/reconcile-engine/rust/Cargo.toml`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "Add pub/sub with glob patterns and single-fire sink"
```

---

### Task 7: Engine + JSON command dispatch

**Files:**
- Create: `packages/reconcile-engine/rust/src/engine.rs`
- Create: `packages/reconcile-engine/rust/src/dispatch.rs`
- Modify: `packages/reconcile-engine/rust/src/lib.rs`

**Interfaces:**
- Consumes: everything above
- Produces:
```rust
pub struct Engine {
    pub store: Store,
    pub sources: std::collections::HashMap<String, SourceConfig>,
    pub pubsub: PubSub,
    pub clock: Box<dyn Fn() -> i64 + Send>,
}

impl Engine {
    pub fn open(path: &str, clock: Box<dyn Fn() -> i64 + Send>) -> Result<Engine, EngineError>;
    pub fn ingest(&mut self, source_id: &str, payload: &str) -> Result<BatchSummary, EngineError>;
    pub fn ingest_file(&mut self, source_id: &str, path: &str) -> Result<BatchSummary, EngineError>;
}

// dispatch.rs
pub fn execute(engine: &mut Engine, request_json: &str) -> String;
```
- Request envelope: `{"cmd": "<name>", "args": [..strings..]}`. Response: `{"ok":true,"value":<json>}` or `{"ok":false,"code":<u32>,"message":"..."}`.
- Commands: `get k`, `set k v`, `del k`, `mget k1 k2..`, `scan pattern`, `hget k f`, `hset k f v`, `hgetall k`, `expire k ttl_ms`, `ttl k`, `subscribe pattern`, `unsubscribe id`, `registerSource <config-json>`, `ingest sourceId payload`, `ingestFile sourceId path`, `deadLetterCount`.
- `ingest` idempotency: hash payload with `std::collections::hash_map::DefaultHasher`; if `sync_meta.content_hash` for the source matches, return all-unchanged summary without reconciling.
- After a reconcile with non-empty `collections`, publish to `changes:{collection}` for each, payload = the `BatchSummary` JSON.

- [ ] **Step 1: Write failing tests** (in `dispatch.rs`)

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::Engine;

    fn eng() -> Engine {
        Engine::open(":memory:", Box::new(|| 1000)).unwrap()
    }

    fn ok_value(resp: &str) -> serde_json::Value {
        let v: serde_json::Value = serde_json::from_str(resp).unwrap();
        assert_eq!(v["ok"], true, "expected ok response, got {resp}");
        v["value"].clone()
    }

    #[test]
    fn set_get_via_dispatch() {
        let mut e = eng();
        ok_value(&execute(&mut e, r#"{"cmd":"set","args":["a","1"]}"#));
        assert_eq!(ok_value(&execute(&mut e, r#"{"cmd":"get","args":["a"]}"#)), "1");
        assert!(ok_value(&execute(&mut e, r#"{"cmd":"get","args":["nope"]}"#)).is_null());
    }

    #[test]
    fn unknown_command_is_error_envelope() {
        let mut e = eng();
        let v: serde_json::Value =
            serde_json::from_str(&execute(&mut e, r#"{"cmd":"flushall","args":[]}"#)).unwrap();
        assert_eq!(v["ok"], false);
        assert_eq!(v["code"], 4);
    }

    #[test]
    fn malformed_request_is_error_envelope_not_panic() {
        let mut e = eng();
        let v: serde_json::Value = serde_json::from_str(&execute(&mut e, "{nope")).unwrap();
        assert_eq!(v["ok"], false);
    }

    #[test]
    fn register_source_and_ingest_publishes_changes() {
        let mut e = eng();
        let seen = std::sync::Arc::new(std::sync::Mutex::new(vec![]));
        let s2 = seen.clone();
        e.pubsub.set_sink(Box::new(move |ch, _| s2.lock().unwrap().push(ch.to_string())));
        let cfg = r#"{"source_id":"api","format":"Json","collection":"people","natural_key_field":"email","timestamp_field":null,"priority":10}"#;
        ok_value(&execute(&mut e, &format!(
            r#"{{"cmd":"registerSource","args":[{}]}}"#,
            serde_json::to_string(cfg).unwrap()
        )));
        ok_value(&execute(&mut e, r#"{"cmd":"subscribe","args":["changes:*"]}"#));
        let payload = r#"[{"email":"a@x.com","name":"Ann"}]"#;
        let summary = ok_value(&execute(&mut e, &format!(
            r#"{{"cmd":"ingest","args":["api",{}]}}"#,
            serde_json::to_string(payload).unwrap()
        )));
        assert_eq!(summary["inserted"], 1);
        assert_eq!(seen.lock().unwrap().as_slice(), ["changes:people"]);
        // read back through redis surface
        let h = ok_value(&execute(&mut e, r#"{"cmd":"hgetall","args":["entry:people:a@x.com"]}"#));
        assert_eq!(h["name"], "Ann");
    }

    #[test]
    fn duplicate_ingest_is_skipped_by_content_hash() {
        let mut e = eng();
        let cfg = r#"{"source_id":"api","format":"Json","collection":"people","natural_key_field":"email","timestamp_field":null,"priority":10}"#;
        ok_value(&execute(&mut e, &format!(
            r#"{{"cmd":"registerSource","args":[{}]}}"#,
            serde_json::to_string(cfg).unwrap()
        )));
        let payload = r#"[{"email":"a@x.com","name":"Ann"}]"#;
        let req = format!(
            r#"{{"cmd":"ingest","args":["api",{}]}}"#,
            serde_json::to_string(payload).unwrap()
        );
        let first = ok_value(&execute(&mut e, &req));
        assert_eq!(first["inserted"], 1);
        let second = ok_value(&execute(&mut e, &req));
        assert_eq!(second["inserted"], 0);
        assert_eq!(second["skipped"], true);
    }

    #[test]
    fn ingest_unknown_source_is_source_error() {
        let mut e = eng();
        let v: serde_json::Value = serde_json::from_str(&execute(
            &mut e,
            r#"{"cmd":"ingest","args":["ghost","[]"]}"#,
        ))
        .unwrap();
        assert_eq!(v["ok"], false);
        assert_eq!(v["code"], 3);
    }
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test --manifest-path packages/reconcile-engine/rust/Cargo.toml dispatch`
Expected: compile errors.

- [ ] **Step 3: Implement `engine.rs`**

```rust
use crate::error::EngineError;
use crate::normalize::{normalize, SourceConfig};
use crate::pubsub::PubSub;
use crate::reconcile::{reconcile, BatchSummary};
use crate::store::Store;
use rusqlite::params;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};

pub struct Engine {
    pub store: Store,
    pub sources: HashMap<String, SourceConfig>,
    pub pubsub: PubSub,
    pub clock: Box<dyn Fn() -> i64 + Send>,
}

impl Engine {
    pub fn open(path: &str, clock: Box<dyn Fn() -> i64 + Send>) -> Result<Engine, EngineError> {
        Ok(Engine {
            store: Store::open(path)?,
            sources: HashMap::new(),
            pubsub: PubSub::new(),
            clock,
        })
    }

    pub fn now(&self) -> i64 {
        (self.clock)()
    }

    /// Returns (summary, skipped) — skipped=true when the payload content-hash
    /// matched the previous ingest for this source and reconcile was bypassed.
    pub fn ingest(&mut self, source_id: &str, payload: &str) -> Result<(BatchSummary, bool), EngineError> {
        let cfg = self
            .sources
            .get(source_id)
            .cloned()
            .ok_or_else(|| EngineError::Source(format!("unknown source '{source_id}'")))?;
        let now = self.now();

        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        payload.hash(&mut hasher);
        let content_hash = format!("{:x}", hasher.finish());
        let prev: Option<String> = self
            .store
            .conn
            .query_row(
                "SELECT content_hash FROM sync_meta WHERE source = ?1",
                params![source_id],
                |r| r.get(0),
            )
            .ok()
            .flatten();
        if prev.as_deref() == Some(content_hash.as_str()) {
            return Ok((
                BatchSummary {
                    inserted: 0,
                    updated: 0,
                    unchanged: 0,
                    dead_lettered: 0,
                    collections: vec![],
                },
                true,
            ));
        }

        let outcome = normalize(&cfg, payload, now)?;
        let summary = reconcile(&mut self.store, &cfg, outcome, now)?;
        self.store.conn.execute(
            "UPDATE sync_meta SET content_hash = ?2 WHERE source = ?1",
            params![source_id, content_hash],
        )?;
        if !summary.collections.is_empty() {
            let payload_json = serde_json::to_string(&summary).unwrap();
            for c in &summary.collections {
                self.pubsub.publish(&format!("changes:{c}"), &payload_json);
            }
        }
        Ok((summary, false))
    }

    pub fn ingest_file(&mut self, source_id: &str, path: &str) -> Result<(BatchSummary, bool), EngineError> {
        let payload = std::fs::read_to_string(path)
            .map_err(|e| EngineError::Source(format!("cannot read '{path}': {e}")))?;
        self.ingest(source_id, &payload)
    }
}
```

- [ ] **Step 4: Implement `dispatch.rs`**

```rust
use crate::engine::Engine;
use crate::error::EngineError;
use crate::{commands, normalize::SourceConfig};
use serde_json::{json, Value};

fn ok(value: Value) -> String {
    json!({"ok": true, "value": value}).to_string()
}

fn err(e: &EngineError) -> String {
    json!({"ok": false, "code": e.code(), "message": e.to_string()}).to_string()
}

pub fn execute(engine: &mut Engine, request_json: &str) -> String {
    match run(engine, request_json) {
        Ok(v) => ok(v),
        Err(e) => err(&e),
    }
}

fn arg(args: &[String], i: usize) -> Result<&str, EngineError> {
    args.get(i)
        .map(|s| s.as_str())
        .ok_or_else(|| EngineError::Command(format!("missing argument {i}")))
}

fn run(engine: &mut Engine, request_json: &str) -> Result<Value, EngineError> {
    let req: Value = serde_json::from_str(request_json)
        .map_err(|e| EngineError::Command(format!("bad request: {e}")))?;
    let cmd = req["cmd"]
        .as_str()
        .ok_or_else(|| EngineError::Command("missing cmd".into()))?
        .to_string();
    let args: Vec<String> = req["args"]
        .as_array()
        .map(|a| {
            a.iter()
                .map(|v| v.as_str().map(str::to_string).unwrap_or_else(|| v.to_string()))
                .collect()
        })
        .unwrap_or_default();
    let now = engine.now();

    match cmd.as_str() {
        "get" => Ok(json!(commands::get(&engine.store, arg(&args, 0)?, now)?)),
        "set" => {
            commands::set(&engine.store, arg(&args, 0)?, arg(&args, 1)?)?;
            Ok(json!("OK"))
        }
        "del" => Ok(json!(commands::del(&engine.store, arg(&args, 0)?)?)),
        "mget" => Ok(json!(commands::mget(&engine.store, &args, now)?)),
        "scan" => Ok(json!(commands::scan(&engine.store, arg(&args, 0)?, now)?)),
        "hget" => Ok(json!(commands::hget(&engine.store, arg(&args, 0)?, arg(&args, 1)?, now)?)),
        "hset" => {
            commands::hset(&engine.store, arg(&args, 0)?, arg(&args, 1)?, arg(&args, 2)?)?;
            Ok(json!("OK"))
        }
        "hgetall" => Ok(json!(commands::hgetall(&engine.store, arg(&args, 0)?, now)?)),
        "expire" => {
            let ttl_ms: i64 = arg(&args, 1)?
                .parse()
                .map_err(|_| EngineError::Command("ttl must be integer ms".into()))?;
            commands::expire(&engine.store, arg(&args, 0)?, ttl_ms, now)?;
            Ok(json!("OK"))
        }
        "ttl" => Ok(json!(commands::ttl(&engine.store, arg(&args, 0)?, now)?)),
        "subscribe" => Ok(json!(engine.pubsub.subscribe(arg(&args, 0)?))),
        "unsubscribe" => {
            let id: u64 = arg(&args, 0)?
                .parse()
                .map_err(|_| EngineError::Command("id must be integer".into()))?;
            Ok(json!(engine.pubsub.unsubscribe(id)))
        }
        "registerSource" => {
            let cfg: SourceConfig = serde_json::from_str(arg(&args, 0)?)
                .map_err(|e| EngineError::Command(format!("bad source config: {e}")))?;
            engine.sources.insert(cfg.source_id.clone(), cfg);
            Ok(json!("OK"))
        }
        "ingest" => {
            let (summary, skipped) = engine.ingest(arg(&args, 0)?, arg(&args, 1)?)?;
            let mut v = serde_json::to_value(&summary).unwrap();
            v["skipped"] = json!(skipped);
            Ok(v)
        }
        "ingestFile" => {
            let (summary, skipped) = engine.ingest_file(arg(&args, 0)?, arg(&args, 1)?)?;
            let mut v = serde_json::to_value(&summary).unwrap();
            v["skipped"] = json!(skipped);
            Ok(v)
        }
        "deadLetterCount" => {
            let n: i64 = engine
                .store
                .conn
                .query_row("SELECT count(*) FROM dead_letter", [], |r| r.get(0))?;
            Ok(json!(n))
        }
        other => Err(EngineError::Command(format!("unknown command '{other}'"))),
    }
}
```

Add `pub mod engine; pub mod dispatch;` to `lib.rs`.

- [ ] **Step 5: Run all tests**

Run: `cargo test --manifest-path packages/reconcile-engine/rust/Cargo.toml`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "Add engine with ingest idempotency and JSON command dispatch"
```

---

### Task 8: C ABI (ffi.rs), hand-written engine.h, binary row encoding

**Files:**
- Create: `packages/reconcile-engine/rust/src/ffi.rs`
- Create: `packages/reconcile-engine/rust/src/binenc.rs`
- Create: `packages/reconcile-engine/cpp/include/engine.h`
- Modify: `packages/reconcile-engine/rust/src/lib.rs`

**Interfaces:**
- Produces C ABI (all `#[no_mangle] pub extern "C"`):
  - `engine_open(path: *const c_char) -> *mut c_void` — null on failure
  - `engine_last_error() -> *mut c_char` — thread-local last error as `{"code":n,"message":"..."}`; caller frees
  - `engine_execute(handle: *mut c_void, request_json: *const c_char) -> *mut c_char` — response envelope; caller frees
  - `engine_query_entries_bin(handle: *mut c_void, collection: *const c_char, out_len: *mut usize) -> *mut u8` — binary rows; caller frees via `engine_free_bytes`
  - `engine_set_event_callback(handle, ctx: *mut c_void, cb: Option<extern "C" fn(*mut c_void, *const c_char, *const c_char)>)` — (ctx, channel, payload)
  - `engine_free_string(s: *mut c_char)`, `engine_free_bytes(p: *mut u8, len: usize)`, `engine_close(handle)`
- Handle wraps `Mutex<Engine>` — safe to call from any thread.
- Binary encoding (`binenc.rs`): little-endian `[u32 row_count] ([u32 key_len][key utf8][u32 json_len][fields-json utf8])*` via `pub fn encode_entries(rows: &[(String, String)]) -> Vec<u8>`.

- [ ] **Step 1: Write failing tests**

`binenc.rs` tests:
```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_rows_le() {
        let rows = vec![("k1".to_string(), "{\"a\":1}".to_string())];
        let buf = encode_entries(&rows);
        assert_eq!(&buf[0..4], &1u32.to_le_bytes());
        assert_eq!(&buf[4..8], &2u32.to_le_bytes());
        assert_eq!(&buf[8..10], b"k1");
        assert_eq!(&buf[10..14], &7u32.to_le_bytes());
        assert_eq!(&buf[14..21], b"{\"a\":1}");
    }

    #[test]
    fn empty_is_just_count() {
        assert_eq!(encode_entries(&[]), 0u32.to_le_bytes().to_vec());
    }
}
```

`ffi.rs` round-trip test (Rust calling its own C ABI):
```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::{CStr, CString};

    #[test]
    fn c_abi_roundtrip() {
        let path = CString::new(":memory:").unwrap();
        let h = engine_open(path.as_ptr());
        assert!(!h.is_null());

        let req = CString::new(r#"{"cmd":"set","args":["a","1"]}"#).unwrap();
        let resp = engine_execute(h, req.as_ptr());
        let s = unsafe { CStr::from_ptr(resp) }.to_str().unwrap().to_string();
        engine_free_string(resp);
        assert!(s.contains("\"ok\":true"));

        let req2 = CString::new(r#"{"cmd":"get","args":["a"]}"#).unwrap();
        let resp2 = engine_execute(h, req2.as_ptr());
        let s2 = unsafe { CStr::from_ptr(resp2) }.to_str().unwrap().to_string();
        engine_free_string(resp2);
        assert!(s2.contains("\"1\""));

        engine_close(h);
    }

    #[test]
    fn open_failure_sets_last_error() {
        let path = CString::new("/nonexistent-dir-zzz/db.sqlite").unwrap();
        let h = engine_open(path.as_ptr());
        assert!(h.is_null());
        let e = engine_last_error();
        assert!(!e.is_null());
        let s = unsafe { CStr::from_ptr(e) }.to_str().unwrap().to_string();
        engine_free_string(e);
        assert!(s.contains("message"));
    }

    #[test]
    fn event_callback_fires_on_publish() {
        use std::sync::atomic::{AtomicU32, Ordering};
        static FIRED: AtomicU32 = AtomicU32::new(0);
        extern "C" fn cb(_ctx: *mut std::ffi::c_void, _ch: *const std::os::raw::c_char, _p: *const std::os::raw::c_char) {
            FIRED.fetch_add(1, Ordering::SeqCst);
        }
        let path = CString::new(":memory:").unwrap();
        let h = engine_open(path.as_ptr());
        engine_set_event_callback(h, std::ptr::null_mut(), Some(cb));
        for req in [
            r#"{"cmd":"registerSource","args":["{\"source_id\":\"api\",\"format\":\"Json\",\"collection\":\"people\",\"natural_key_field\":\"email\",\"timestamp_field\":null,\"priority\":10}"]}"#,
            r#"{"cmd":"subscribe","args":["changes:*"]}"#,
            r#"{"cmd":"ingest","args":["api","[{\"email\":\"a@x.com\"}]"]}"#,
        ] {
            let c = CString::new(req).unwrap();
            let r = engine_execute(h, c.as_ptr());
            engine_free_string(r);
        }
        assert_eq!(FIRED.load(Ordering::SeqCst), 1);
        engine_close(h);
    }

    #[test]
    fn query_entries_bin_roundtrip() {
        let path = CString::new(":memory:").unwrap();
        let h = engine_open(path.as_ptr());
        for req in [
            r#"{"cmd":"registerSource","args":["{\"source_id\":\"api\",\"format\":\"Json\",\"collection\":\"people\",\"natural_key_field\":\"email\",\"timestamp_field\":null,\"priority\":10}"]}"#,
            r#"{"cmd":"ingest","args":["api","[{\"email\":\"a@x.com\",\"name\":\"Ann\"}]"]}"#,
        ] {
            let c = CString::new(req).unwrap();
            let r = engine_execute(h, c.as_ptr());
            engine_free_string(r);
        }
        let col = CString::new("people").unwrap();
        let mut len: usize = 0;
        let p = engine_query_entries_bin(h, col.as_ptr(), &mut len);
        assert!(!p.is_null());
        let bytes = unsafe { std::slice::from_raw_parts(p, len) }.to_vec();
        engine_free_bytes(p, len);
        assert_eq!(&bytes[0..4], &1u32.to_le_bytes());
        engine_close(h);
    }
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test --manifest-path packages/reconcile-engine/rust/Cargo.toml ffi binenc`
Expected: compile errors.

- [ ] **Step 3: Implement `binenc.rs`**

```rust
pub fn encode_entries(rows: &[(String, String)]) -> Vec<u8> {
    let mut buf = Vec::with_capacity(4 + rows.iter().map(|(k, v)| 8 + k.len() + v.len()).sum::<usize>());
    buf.extend_from_slice(&(rows.len() as u32).to_le_bytes());
    for (key, json) in rows {
        buf.extend_from_slice(&(key.len() as u32).to_le_bytes());
        buf.extend_from_slice(key.as_bytes());
        buf.extend_from_slice(&(json.len() as u32).to_le_bytes());
        buf.extend_from_slice(json.as_bytes());
    }
    buf
}
```

- [ ] **Step 4: Implement `ffi.rs`**

```rust
use crate::binenc::encode_entries;
use crate::dispatch::execute;
use crate::engine::Engine;
use rusqlite::params;
use std::cell::RefCell;
use std::ffi::{c_char, c_void, CStr, CString};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

type EventCb = extern "C" fn(*mut c_void, *const c_char, *const c_char);

/// ctx is an opaque pointer owned by the C++ side; it must outlive the engine.
struct CallbackHolder {
    ctx: usize, // stored as usize so the holder is Send
    cb: EventCb,
}

pub struct EngineFfi {
    inner: Mutex<Engine>,
}

thread_local! {
    static LAST_ERROR: RefCell<Option<String>> = const { RefCell::new(None) };
}

fn set_last_error(code: u32, message: &str) {
    let json = serde_json::json!({"code": code, "message": message}).to_string();
    LAST_ERROR.with(|e| *e.borrow_mut() = Some(json));
}

fn to_c_string(s: String) -> *mut c_char {
    CString::new(s).unwrap_or_else(|_| CString::new("{\"ok\":false,\"code\":2,\"message\":\"interior nul\"}").unwrap()).into_raw()
}

unsafe fn cstr<'a>(p: *const c_char) -> Option<&'a str> {
    if p.is_null() {
        return None;
    }
    CStr::from_ptr(p).to_str().ok()
}

fn real_clock() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[no_mangle]
pub extern "C" fn engine_open(path: *const c_char) -> *mut c_void {
    let Some(path) = (unsafe { cstr(path) }) else {
        set_last_error(4, "null or invalid path");
        return std::ptr::null_mut();
    };
    match Engine::open(path, Box::new(real_clock)) {
        Ok(e) => Box::into_raw(Box::new(EngineFfi { inner: Mutex::new(e) })) as *mut c_void,
        Err(e) => {
            set_last_error(e.code(), &e.to_string());
            std::ptr::null_mut()
        }
    }
}

#[no_mangle]
pub extern "C" fn engine_last_error() -> *mut c_char {
    LAST_ERROR.with(|e| match e.borrow().as_ref() {
        Some(s) => to_c_string(s.clone()),
        None => std::ptr::null_mut(),
    })
}

#[no_mangle]
pub extern "C" fn engine_execute(handle: *mut c_void, request_json: *const c_char) -> *mut c_char {
    if handle.is_null() {
        return to_c_string("{\"ok\":false,\"code\":4,\"message\":\"null engine handle\"}".into());
    }
    let ffi = unsafe { &*(handle as *mut EngineFfi) };
    let Some(req) = (unsafe { cstr(request_json) }) else {
        return to_c_string("{\"ok\":false,\"code\":4,\"message\":\"null request\"}".into());
    };
    let mut engine = ffi.inner.lock().unwrap();
    to_c_string(execute(&mut engine, req))
}

#[no_mangle]
pub extern "C" fn engine_query_entries_bin(
    handle: *mut c_void,
    collection: *const c_char,
    out_len: *mut usize,
) -> *mut u8 {
    if handle.is_null() || out_len.is_null() {
        return std::ptr::null_mut();
    }
    let ffi = unsafe { &*(handle as *mut EngineFfi) };
    let Some(collection) = (unsafe { cstr(collection) }) else {
        return std::ptr::null_mut();
    };
    let engine = ffi.inner.lock().unwrap();
    let mut rows: Vec<(String, String)> = vec![];
    let result = (|| -> Result<(), rusqlite::Error> {
        let mut stmt = engine
            .store
            .conn
            .prepare("SELECT natural_key, fields FROM entries WHERE collection = ?1 ORDER BY natural_key")?;
        let iter = stmt.query_map(params![collection], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?;
        for row in iter {
            rows.push(row?);
        }
        Ok(())
    })();
    if let Err(e) = result {
        set_last_error(2, &e.to_string());
        return std::ptr::null_mut();
    }
    let buf = encode_entries(&rows);
    let len = buf.len();
    let ptr = Box::into_raw(buf.into_boxed_slice()) as *mut u8;
    unsafe { *out_len = len };
    ptr
}

#[no_mangle]
pub extern "C" fn engine_set_event_callback(
    handle: *mut c_void,
    ctx: *mut c_void,
    cb: Option<EventCb>,
) {
    if handle.is_null() {
        return;
    }
    let ffi = unsafe { &*(handle as *mut EngineFfi) };
    let mut engine = ffi.inner.lock().unwrap();
    match cb {
        Some(cb) => {
            let holder = CallbackHolder { ctx: ctx as usize, cb };
            engine.pubsub.set_sink(Box::new(move |channel, payload| {
                let ch = CString::new(channel).unwrap();
                let pl = CString::new(payload).unwrap();
                (holder.cb)(holder.ctx as *mut c_void, ch.as_ptr(), pl.as_ptr());
            }));
        }
        None => engine.pubsub.set_sink(Box::new(|_, _| {})),
    }
}

#[no_mangle]
pub extern "C" fn engine_free_string(s: *mut c_char) {
    if !s.is_null() {
        unsafe { drop(CString::from_raw(s)) };
    }
}

#[no_mangle]
pub extern "C" fn engine_free_bytes(p: *mut u8, len: usize) {
    if !p.is_null() {
        unsafe {
            drop(Box::from_raw(std::slice::from_raw_parts_mut(p, len) as *mut [u8]));
        }
    }
}

#[no_mangle]
pub extern "C" fn engine_close(handle: *mut c_void) {
    if !handle.is_null() {
        unsafe { drop(Box::from_raw(handle as *mut EngineFfi)) };
    }
}
```

Add `pub mod ffi; pub mod binenc;` to `lib.rs`.

- [ ] **Step 5: Hand-write `cpp/include/engine.h`**

```c
#pragma once
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef void* engine_handle_t;
typedef void (*engine_event_cb)(void* ctx, const char* channel, const char* payload_json);

/* Returns NULL on failure; see engine_last_error(). */
engine_handle_t engine_open(const char* path);

/* Thread-local error as {"code":n,"message":"..."} JSON, or NULL. Free with engine_free_string. */
char* engine_last_error(void);

/* Executes a {"cmd":...,"args":[...]} request; returns response JSON. Free with engine_free_string. */
char* engine_execute(engine_handle_t engine, const char* request_json);

/* Binary rows: LE [u32 count]([u32 klen][key][u32 jlen][fields-json])*. Free with engine_free_bytes. */
unsigned char* engine_query_entries_bin(engine_handle_t engine, const char* collection, size_t* out_len);

/* cb may be called from any thread holding the engine lock; keep it fast, copy strings out. */
void engine_set_event_callback(engine_handle_t engine, void* ctx, engine_event_cb cb);

void engine_free_string(char* s);
void engine_free_bytes(unsigned char* p, size_t len);
void engine_close(engine_handle_t engine);

#ifdef __cplusplus
}
#endif
```

- [ ] **Step 6: Run all tests**

Run: `cargo test --manifest-path packages/reconcile-engine/rust/Cargo.toml`
Expected: all pass. **The Rust core is now complete and fully tested.**

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "Add C ABI with hand-written header and binary row encoding"
```

---

### Task 9: TS package — Turbo Module spec, codegen config, JS API wrapper

**Files:**
- Create: `packages/reconcile-engine/package.json`
- Create: `packages/reconcile-engine/tsconfig.json`
- Create: `packages/reconcile-engine/src/NativeReconcileEngine.ts`
- Create: `packages/reconcile-engine/src/index.ts`
- Create: `packages/reconcile-engine/src/__tests__/index.test.ts`
- Create: `packages/reconcile-engine/jest.config.js`

**Interfaces:**
- Consumes: command envelope from Task 7 (`{"cmd","args"}` / `{"ok","value"| "code","message"}`)
- Produces: JS API used by the sandbox:
  - `openEngine(path: string): Promise<void>`
  - `redis` object: `get/set/del/mget/scan/hget/hset/hgetall/expire/ttl` (async, typed)
  - `registerSource(cfg: SourceConfig): Promise<void>`, `ingest(sourceId, payload): Promise<BatchSummary>`, `ingestFile(sourceId, path): Promise<BatchSummary>`
  - `subscribe(pattern: string, handler: (channel: string, summary: BatchSummary) => void): () => void` (returns unsubscribe)
  - `executeRaw(requestJson: string): Promise<string>` and `executeRawSync(requestJson: string): string` (benchmarks)

- [ ] **Step 1: Write package.json with codegenConfig**

```json
{
  "name": "@rn-experiments/reconcile-engine",
  "version": "0.1.0",
  "main": "src/index.ts",
  "scripts": {
    "test": "jest"
  },
  "peerDependencies": {
    "react-native": "*"
  },
  "devDependencies": {
    "@types/jest": "^29.5.0",
    "jest": "^29.7.0",
    "ts-jest": "^29.1.0",
    "typescript": "^5.4.0"
  },
  "codegenConfig": {
    "name": "ReconcileEngineSpec",
    "type": "modules",
    "jsSrcsDir": "src"
  }
}
```

- [ ] **Step 2: Write the Turbo Module spec**

`src/NativeReconcileEngine.ts`:
```typescript
import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';
import type { EventEmitter } from 'react-native/Libraries/Types/CodegenTypes';

export type ChangeEvent = {
  channel: string;
  payload: string; // BatchSummary JSON
};

export interface Spec extends TurboModule {
  open(path: string): void;
  close(): void;
  execute(requestJson: string): Promise<string>;
  executeSync(requestJson: string): string;
  /** Installs global.__reconcileEngine fast-path JSI functions. */
  installFastPath(): boolean;
  readonly onChange: EventEmitter<ChangeEvent>;
}

export default TurboModuleRegistry.getEnforcing<Spec>('NativeReconcileEngine');
```

- [ ] **Step 3: Write failing jest test for the wrapper**

`jest.config.js`:
```js
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  moduleNameMapper: {
    '^react-native$': '<rootDir>/src/__tests__/rn-mock.ts',
    'react-native/Libraries/Types/CodegenTypes': '<rootDir>/src/__tests__/codegen-types-mock.ts',
  },
};
```

`src/__tests__/rn-mock.ts`:
```typescript
export const mockNative = {
  open: jest.fn(),
  close: jest.fn(),
  execute: jest.fn(),
  executeSync: jest.fn(),
  installFastPath: jest.fn(() => true),
  onChange: {
    listeners: [] as Array<(e: { channel: string; payload: string }) => void>,
    addListener(fn: (e: { channel: string; payload: string }) => void) {
      this.listeners.push(fn);
      return { remove: () => { this.listeners = this.listeners.filter((l) => l !== fn); } };
    },
    emit(e: { channel: string; payload: string }) {
      this.listeners.forEach((l) => l(e));
    },
  },
};

export const TurboModuleRegistry = {
  getEnforcing: () => mockNative,
};
export type TurboModule = object;
```

`src/__tests__/codegen-types-mock.ts`:
```typescript
export type EventEmitter<T> = {
  addListener(fn: (e: T) => void): { remove(): void };
};
```

`src/__tests__/index.test.ts`:
```typescript
import { mockNative } from './rn-mock';
import { openEngine, redis, ingest, registerSource, subscribe } from '../index';

const okResp = (value: unknown) => JSON.stringify({ ok: true, value });
const errResp = (code: number, message: string) =>
  JSON.stringify({ ok: false, code, message });

beforeEach(() => {
  jest.clearAllMocks();
  mockNative.onChange.listeners = [];
});

test('openEngine calls native open', async () => {
  await openEngine('/tmp/db.sqlite');
  expect(mockNative.open).toHaveBeenCalledWith('/tmp/db.sqlite');
});

test('redis.get sends envelope and unwraps value', async () => {
  mockNative.execute.mockResolvedValue(okResp('1'));
  const v = await redis.get('a');
  expect(mockNative.execute).toHaveBeenCalledWith(
    JSON.stringify({ cmd: 'get', args: ['a'] }),
  );
  expect(v).toBe('1');
});

test('error envelope becomes typed Error', async () => {
  mockNative.execute.mockResolvedValue(errResp(4, "unknown command 'x'"));
  await expect(redis.get('a')).rejects.toThrow("unknown command 'x'");
  await expect(redis.get('a')).rejects.toMatchObject({ code: 4 });
});

test('ingest parses BatchSummary', async () => {
  mockNative.execute.mockResolvedValue(
    okResp({ inserted: 2, updated: 0, unchanged: 0, dead_lettered: 1, collections: ['people'], skipped: false }),
  );
  const s = await ingest('api', '[...]');
  expect(s.inserted).toBe(2);
  expect(s.collections).toEqual(['people']);
});

test('registerSource serializes config as single arg', async () => {
  mockNative.execute.mockResolvedValue(okResp('OK'));
  await registerSource({
    source_id: 'api', format: 'Json', collection: 'people',
    natural_key_field: 'email', timestamp_field: null, priority: 10,
  });
  const sent = JSON.parse(mockNative.execute.mock.calls[0][0]);
  expect(sent.cmd).toBe('registerSource');
  expect(JSON.parse(sent.args[0]).source_id).toBe('api');
});

test('subscribe routes matching channels and unsubscribes', async () => {
  mockNative.execute.mockResolvedValue(okResp(1));
  const seen: string[] = [];
  const unsub = await subscribe('changes:*', (channel) => seen.push(channel));
  mockNative.onChange.emit({ channel: 'changes:people', payload: '{"inserted":1}' });
  mockNative.onChange.emit({ channel: 'other:thing', payload: '{}' });
  expect(seen).toEqual(['changes:people']);
  unsub();
  mockNative.onChange.emit({ channel: 'changes:people', payload: '{}' });
  expect(seen).toEqual(['changes:people']);
});
```

- [ ] **Step 4: Run to verify failure**

Run: `cd packages/reconcile-engine && yarn install && yarn test`
Expected: FAIL — `../index` doesn't exist.

- [ ] **Step 5: Implement `src/index.ts`**

```typescript
import NativeReconcileEngine from './NativeReconcileEngine';

export type SourceConfig = {
  source_id: string;
  format: 'Json' | 'Csv';
  collection: string;
  natural_key_field: string;
  timestamp_field: string | null;
  priority: number;
};

export type BatchSummary = {
  inserted: number;
  updated: number;
  unchanged: number;
  dead_lettered: number;
  collections: string[];
  skipped?: boolean;
};

export class EngineError extends Error {
  constructor(public code: number, message: string) {
    super(message);
    this.name = 'EngineError';
  }
}

function unwrap<T>(responseJson: string): T {
  const resp = JSON.parse(responseJson);
  if (!resp.ok) throw new EngineError(resp.code, resp.message);
  return resp.value as T;
}

async function call<T>(cmd: string, args: string[]): Promise<T> {
  return unwrap<T>(await NativeReconcileEngine.execute(JSON.stringify({ cmd, args })));
}

export async function openEngine(path: string): Promise<void> {
  NativeReconcileEngine.open(path);
}

export function closeEngine(): void {
  NativeReconcileEngine.close();
}

export const redis = {
  get: (key: string) => call<string | null>('get', [key]),
  set: (key: string, value: string) => call<'OK'>('set', [key, value]),
  del: (key: string) => call<boolean>('del', [key]),
  mget: (...keys: string[]) => call<Array<string | null>>('mget', keys),
  scan: (pattern: string) => call<string[]>('scan', [pattern]),
  hget: (key: string, field: string) => call<string | null>('hget', [key, field]),
  hset: (key: string, field: string, value: string) => call<'OK'>('hset', [key, field, value]),
  hgetall: (key: string) => call<Record<string, string>>('hgetall', [key]),
  expire: (key: string, ttlMs: number) => call<'OK'>('expire', [key, String(ttlMs)]),
  ttl: (key: string) => call<number | null>('ttl', [key]),
};

export function registerSource(cfg: SourceConfig): Promise<void> {
  return call<'OK'>('registerSource', [JSON.stringify(cfg)]).then(() => undefined);
}

export function ingest(sourceId: string, payload: string): Promise<BatchSummary> {
  return call<BatchSummary>('ingest', [sourceId, payload]);
}

export function ingestFile(sourceId: string, path: string): Promise<BatchSummary> {
  return call<BatchSummary>('ingestFile', [sourceId, path]);
}

function globToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

export async function subscribe(
  pattern: string,
  handler: (channel: string, summary: BatchSummary) => void,
): Promise<() => void> {
  const id = await call<number>('subscribe', [pattern]);
  const re = globToRegex(pattern);
  const sub = NativeReconcileEngine.onChange.addListener((e) => {
    if (re.test(e.channel)) handler(e.channel, JSON.parse(e.payload));
  });
  return () => {
    sub.remove();
    void call<boolean>('unsubscribe', [String(id)]);
  };
}

export function executeRaw(requestJson: string): Promise<string> {
  return NativeReconcileEngine.execute(requestJson);
}

export function executeRawSync(requestJson: string): string {
  return NativeReconcileEngine.executeSync(requestJson);
}

export function installFastPath(): boolean {
  return NativeReconcileEngine.installFastPath();
}
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "es2020",
    "module": "commonjs",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["src"]
}
```

- [ ] **Step 6: Run tests**

Run: `cd packages/reconcile-engine && yarn test`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "Add TS turbo module spec and JS API wrapper with envelope protocol"
```

---

### Task 10: C++ Turbo Module implementation

**Files:**
- Create: `packages/reconcile-engine/cpp/NativeReconcileEngine.h`
- Create: `packages/reconcile-engine/cpp/NativeReconcileEngine.cpp`

**Interfaces:**
- Consumes: `engine.h` C ABI (Task 8), codegen-generated `ReconcileEngineSpecJSI.h` (generated when the app builds; class base `NativeReconcileEngineCxxSpec<T>`)
- Produces: `facebook::react::NativeReconcileEngine` C++ class; `kModuleName` = `"NativeReconcileEngine"`.

**Design:** one background worker thread (`std::thread` + task queue) owns all async `execute` calls; promises are resolved through `jsInvoker_->invokeAsync`. The Rust event callback (fired on whichever thread called `engine_execute`) copies channel/payload into strings and posts `emitOnChange` via the invoker. `installFastPath` installs two JSI host functions on `global.__reconcileEngine`: `queryEntriesBuffer(collection) -> ArrayBuffer` and `queryEntriesObjects(collection) -> Array<Object>` (decodes the same binary buffer into JSI objects in C++).

- [ ] **Step 1: Write header**

`cpp/NativeReconcileEngine.h`:
```cpp
#pragma once

#include <ReconcileEngineSpecJSI.h>

#include <condition_variable>
#include <functional>
#include <memory>
#include <mutex>
#include <queue>
#include <string>
#include <thread>

#include "include/engine.h"

namespace facebook::react {

class NativeReconcileEngine
    : public NativeReconcileEngineCxxSpec<NativeReconcileEngine> {
 public:
  explicit NativeReconcileEngine(std::shared_ptr<CallInvoker> jsInvoker);
  ~NativeReconcileEngine() override;

  void open(jsi::Runtime& rt, std::string path);
  void close(jsi::Runtime& rt);
  AsyncPromise<std::string> execute(jsi::Runtime& rt, std::string requestJson);
  std::string executeSync(jsi::Runtime& rt, std::string requestJson);
  bool installFastPath(jsi::Runtime& rt);

 private:
  void workerLoop();
  void post(std::function<void()> task);
  static void eventTrampoline(void* ctx, const char* channel, const char* payload);

  engine_handle_t engine_{nullptr};
  std::mutex engineMutex_;

  std::thread worker_;
  std::mutex queueMutex_;
  std::condition_variable queueCv_;
  std::queue<std::function<void()>> queue_;
  bool stopping_{false};
};

} // namespace facebook::react
```

- [ ] **Step 2: Write implementation**

`cpp/NativeReconcileEngine.cpp`:
```cpp
#include "NativeReconcileEngine.h"

#include <cstring>
#include <stdexcept>
#include <vector>

namespace facebook::react {

namespace {
std::string takeRustString(char* s) {
  if (s == nullptr) {
    return "{\"ok\":false,\"code\":2,\"message\":\"null response from engine\"}";
  }
  std::string out(s);
  engine_free_string(s);
  return out;
}
} // namespace

NativeReconcileEngine::NativeReconcileEngine(std::shared_ptr<CallInvoker> jsInvoker)
    : NativeReconcileEngineCxxSpec(std::move(jsInvoker)),
      worker_([this] { workerLoop(); }) {}

NativeReconcileEngine::~NativeReconcileEngine() {
  {
    std::lock_guard<std::mutex> lock(queueMutex_);
    stopping_ = true;
  }
  queueCv_.notify_all();
  if (worker_.joinable()) {
    worker_.join();
  }
  std::lock_guard<std::mutex> lock(engineMutex_);
  if (engine_ != nullptr) {
    engine_close(engine_);
    engine_ = nullptr;
  }
}

void NativeReconcileEngine::workerLoop() {
  for (;;) {
    std::function<void()> task;
    {
      std::unique_lock<std::mutex> lock(queueMutex_);
      queueCv_.wait(lock, [this] { return stopping_ || !queue_.empty(); });
      if (stopping_ && queue_.empty()) {
        return;
      }
      task = std::move(queue_.front());
      queue_.pop();
    }
    task();
  }
}

void NativeReconcileEngine::post(std::function<void()> task) {
  {
    std::lock_guard<std::mutex> lock(queueMutex_);
    queue_.push(std::move(task));
  }
  queueCv_.notify_one();
}

void NativeReconcileEngine::eventTrampoline(void* ctx, const char* channel, const char* payload) {
  auto* self = static_cast<NativeReconcileEngine*>(ctx);
  std::string ch(channel != nullptr ? channel : "");
  std::string pl(payload != nullptr ? payload : "");
  self->jsInvoker_->invokeAsync([self, ch, pl]() {
    self->emitOnChange({ch, pl});
  });
}

void NativeReconcileEngine::open(jsi::Runtime& rt, std::string path) {
  std::lock_guard<std::mutex> lock(engineMutex_);
  if (engine_ != nullptr) {
    return; // already open — idempotent for the sandbox
  }
  engine_ = engine_open(path.c_str());
  if (engine_ == nullptr) {
    std::string err = takeRustString(engine_last_error());
    throw jsi::JSError(rt, "engine_open failed: " + err);
  }
  engine_set_event_callback(engine_, this, &NativeReconcileEngine::eventTrampoline);
}

void NativeReconcileEngine::close(jsi::Runtime& rt) {
  std::lock_guard<std::mutex> lock(engineMutex_);
  if (engine_ != nullptr) {
    engine_close(engine_);
    engine_ = nullptr;
  }
}

AsyncPromise<std::string> NativeReconcileEngine::execute(jsi::Runtime& rt, std::string requestJson) {
  auto promise = AsyncPromise<std::string>(rt, jsInvoker_);
  post([this, promise, requestJson = std::move(requestJson)]() mutable {
    std::lock_guard<std::mutex> lock(engineMutex_);
    if (engine_ == nullptr) {
      promise.reject("engine not open");
      return;
    }
    char* resp = engine_execute(engine_, requestJson.c_str());
    promise.resolve(takeRustString(resp));
  });
  return promise;
}

std::string NativeReconcileEngine::executeSync(jsi::Runtime& rt, std::string requestJson) {
  std::lock_guard<std::mutex> lock(engineMutex_);
  if (engine_ == nullptr) {
    throw jsi::JSError(rt, "engine not open");
  }
  return takeRustString(engine_execute(engine_, requestJson.c_str()));
}

bool NativeReconcileEngine::installFastPath(jsi::Runtime& rt) {
  auto queryBuffer = jsi::Function::createFromHostFunction(
      rt,
      jsi::PropNameID::forAscii(rt, "queryEntriesBuffer"),
      1,
      [this](jsi::Runtime& rt, const jsi::Value&, const jsi::Value* args, size_t count) -> jsi::Value {
        if (count < 1 || !args[0].isString()) {
          throw jsi::JSError(rt, "queryEntriesBuffer(collection: string)");
        }
        std::string collection = args[0].asString(rt).utf8(rt);
        size_t len = 0;
        unsigned char* data = nullptr;
        {
          std::lock_guard<std::mutex> lock(engineMutex_);
          if (engine_ == nullptr) {
            throw jsi::JSError(rt, "engine not open");
          }
          data = engine_query_entries_bin(engine_, collection.c_str(), &len);
        }
        if (data == nullptr) {
          throw jsi::JSError(rt, "queryEntriesBuffer failed: " + takeRustString(engine_last_error()));
        }
        jsi::Function ctor = rt.global().getPropertyAsFunction(rt, "ArrayBuffer");
        jsi::Object abObj = ctor.callAsConstructor(rt, static_cast<int>(len)).getObject(rt);
        jsi::ArrayBuffer ab = abObj.getArrayBuffer(rt);
        std::memcpy(ab.data(rt), data, len);
        engine_free_bytes(data, len);
        return abObj;
      });

  auto queryObjects = jsi::Function::createFromHostFunction(
      rt,
      jsi::PropNameID::forAscii(rt, "queryEntriesObjects"),
      1,
      [this](jsi::Runtime& rt, const jsi::Value&, const jsi::Value* args, size_t count) -> jsi::Value {
        if (count < 1 || !args[0].isString()) {
          throw jsi::JSError(rt, "queryEntriesObjects(collection: string)");
        }
        std::string collection = args[0].asString(rt).utf8(rt);
        size_t len = 0;
        unsigned char* data = nullptr;
        {
          std::lock_guard<std::mutex> lock(engineMutex_);
          if (engine_ == nullptr) {
            throw jsi::JSError(rt, "engine not open");
          }
          data = engine_query_entries_bin(engine_, collection.c_str(), &len);
        }
        if (data == nullptr) {
          throw jsi::JSError(rt, "queryEntriesObjects failed: " + takeRustString(engine_last_error()));
        }
        // Decode: LE [u32 count]([u32 klen][key][u32 jlen][json])*
        auto readU32 = [&](size_t off) -> uint32_t {
          uint32_t v;
          std::memcpy(&v, data + off, 4);
          return v;
        };
        size_t off = 0;
        uint32_t rows = readU32(off);
        off += 4;
        jsi::Array out(rt, rows);
        jsi::Function jsonParse = rt.global()
            .getPropertyAsObject(rt, "JSON")
            .getPropertyAsFunction(rt, "parse");
        for (uint32_t i = 0; i < rows; i++) {
          uint32_t klen = readU32(off); off += 4;
          std::string key(reinterpret_cast<char*>(data + off), klen); off += klen;
          uint32_t jlen = readU32(off); off += 4;
          std::string json(reinterpret_cast<char*>(data + off), jlen); off += jlen;
          jsi::Object row(rt);
          row.setProperty(rt, "key", jsi::String::createFromUtf8(rt, key));
          row.setProperty(rt, "fields", jsonParse.call(rt, jsi::String::createFromUtf8(rt, json)));
          out.setValueAtIndex(rt, i, row);
        }
        engine_free_bytes(data, len);
        return out;
      });

  jsi::Object ns(rt);
  ns.setProperty(rt, "queryEntriesBuffer", queryBuffer);
  ns.setProperty(rt, "queryEntriesObjects", queryObjects);
  rt.global().setProperty(rt, "__reconcileEngine", ns);
  return true;
}

} // namespace facebook::react
```

- [ ] **Step 3: Verify against generated spec (checked later at app build)**

This file compiles only inside an app build once codegen has produced `ReconcileEngineSpecJSI.h`. When Task 13 first builds iOS, open the generated header (`ios/build/generated/ios/ReconcileEngineSpecJSI.h` or the Pods equivalent) and confirm: the base class template name, the exact `AsyncPromise`/promise signature codegen expects for `execute`, and the generated emitter method name (`emitOnChange`). Adjust signatures here to match the generated header exactly — the generated header is the source of truth; this step is expected to require small mechanical fixes.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "Add C++ turbo module with worker thread, events, and JSI fast paths"
```

---

### Task 11: Rust cross-compilation build scripts

**Files:**
- Create: `packages/reconcile-engine/scripts/build-ios.sh`
- Create: `packages/reconcile-engine/scripts/build-android.sh`

**Interfaces:**
- Produces: `packages/reconcile-engine/ios-rust/ReconcileEngine.xcframework` (static, device + simulator) and `packages/reconcile-engine/android-rust/<abi>/libreconcile_engine.a` for `arm64-v8a` and `x86_64`.

- [ ] **Step 1: Install toolchains**

```bash
rustup target add aarch64-apple-ios aarch64-apple-ios-sim
rustup target add aarch64-linux-android x86_64-linux-android
cargo install cargo-ndk
```
(`cargo-ndk` is a build-time host tool, not a runtime dependency — allowed.)
Requires: Xcode + an installed Android NDK (`ANDROID_NDK_HOME` set, or sdkmanager-installed NDK).

- [ ] **Step 2: Write `scripts/build-ios.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../rust"

cargo build --release --target aarch64-apple-ios
cargo build --release --target aarch64-apple-ios-sim

OUT="../ios-rust"
rm -rf "$OUT/ReconcileEngine.xcframework"
mkdir -p "$OUT"

xcodebuild -create-xcframework \
  -library target/aarch64-apple-ios/release/libreconcile_engine.a \
  -headers ../cpp/include \
  -library target/aarch64-apple-ios-sim/release/libreconcile_engine.a \
  -headers ../cpp/include \
  -output "$OUT/ReconcileEngine.xcframework"

echo "Built $OUT/ReconcileEngine.xcframework"
```

- [ ] **Step 3: Write `scripts/build-android.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../rust"

OUT="../android-rust"
rm -rf "$OUT"
mkdir -p "$OUT"

cargo ndk -t arm64-v8a -t x86_64 build --release

cp target/aarch64-linux-android/release/libreconcile_engine.a "$OUT/arm64-v8a-libreconcile_engine.a" 2>/dev/null || true
mkdir -p "$OUT/arm64-v8a" "$OUT/x86_64"
cp target/aarch64-linux-android/release/libreconcile_engine.a "$OUT/arm64-v8a/libreconcile_engine.a"
cp target/x86_64-linux-android/release/libreconcile_engine.a "$OUT/x86_64/libreconcile_engine.a"

echo "Built static libs under $OUT/"
```

- [ ] **Step 4: Run both and verify artifacts**

Run: `chmod +x packages/reconcile-engine/scripts/*.sh && packages/reconcile-engine/scripts/build-ios.sh && packages/reconcile-engine/scripts/build-android.sh`
Expected: xcframework directory exists with both slices (`ls packages/reconcile-engine/ios-rust/ReconcileEngine.xcframework`); `.a` files exist for both Android ABIs.

- [ ] **Step 5: Commit** (scripts only; artifacts are gitignored — add `ios-rust/` and `android-rust/` to `.gitignore`)

```bash
git add -A && git commit -m "Add iOS xcframework and Android static-lib build scripts"
```

---

### Task 12: Expo sandbox scaffold (bare workflow, dev client)

**Files:**
- Create: `apps/sandbox/` (via create-expo-app + prebuild; `android/` and `ios/` are committed — no more prebuild after this)

- [ ] **Step 1: Scaffold**

```bash
cd apps
npx create-expo-app@latest sandbox --template blank-typescript
cd sandbox
npx expo install expo-dev-client
yarn add @rn-experiments/reconcile-engine@0.1.0
```
(Workspace resolution links the local package; verify `node_modules/@rn-experiments/reconcile-engine` is a symlink or workspace copy.)

- [ ] **Step 2: Prebuild once and commit native dirs**

```bash
npx expo prebuild
```
Remove `/android` and `/ios` from `apps/sandbox/.gitignore` so native dirs are committed. From here on, native config is hand-edited (raw approach); never run prebuild again.

- [ ] **Step 3: Verify baseline app builds and boots (new architecture is default)**

```bash
npx expo run:ios   # or start with the simulator you have
```
Expected: default blank app renders in simulator with the dev client.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "Scaffold expo sandbox with dev client and committed native projects"
```

---

### Task 13: iOS wiring

**Files:**
- Create: `packages/reconcile-engine/ReconcileEngine.podspec`
- Create: `packages/reconcile-engine/ios/ReconcileEngineProvider.h`
- Create: `packages/reconcile-engine/ios/ReconcileEngineProvider.mm`
- Modify: `apps/sandbox/package.json` (app codegenConfig `ios.modulesProvider`)
- Modify: `apps/sandbox/ios/Podfile`

- [ ] **Step 1: Write podspec**

`packages/reconcile-engine/ReconcileEngine.podspec`:
```ruby
require "json"
package = JSON.parse(File.read(File.join(__dir__, "package.json")))

Pod::Spec.new do |s|
  s.name         = "ReconcileEngine"
  s.version      = package["version"]
  s.summary      = "Redis-esque Rust reconcile engine turbo module"
  s.homepage     = "https://example.invalid/reconcile-engine"
  s.license      = "MIT"
  s.authors      = { "Initial Studios" => "jake@initialstudios.com.au" }
  s.platforms    = { :ios => "15.1" }
  s.source       = { :path => "." }

  s.source_files = "ios/**/*.{h,mm}", "cpp/**/*.{h,cpp}"
  s.header_mappings_dir = "."
  s.vendored_frameworks = "ios-rust/ReconcileEngine.xcframework"
  s.pod_target_xcconfig = {
    "CLANG_CXX_LANGUAGE_STANDARD" => "c++20",
  }

  install_modules_dependencies(s)
end
```

- [ ] **Step 2: Write the module provider**

`ios/ReconcileEngineProvider.h`:
```objc
#import <Foundation/Foundation.h>
#import <ReactCommon/RCTTurboModule.h>

NS_ASSUME_NONNULL_BEGIN
@interface ReconcileEngineProvider : NSObject <RCTModuleProvider>
@end
NS_ASSUME_NONNULL_END
```

`ios/ReconcileEngineProvider.mm`:
```objc
#import "ReconcileEngineProvider.h"
#import <ReactCommon/CallInvoker.h>
#import <ReactCommon/TurboModule.h>
#import "NativeReconcileEngine.h"

@implementation ReconcileEngineProvider
- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params {
  return std::make_shared<facebook::react::NativeReconcileEngine>(params.jsInvoker);
}
@end
```

- [ ] **Step 3: Point the app at the provider**

In `apps/sandbox/package.json` add:
```json
"codegenConfig": {
  "name": "SandboxSpecs",
  "type": "modules",
  "jsSrcsDir": "specs",
  "ios": {
    "modulesProvider": {
      "NativeReconcileEngine": "ReconcileEngineProvider"
    }
  }
}
```
(`specs/` can be an empty dir with a `.gitkeep`; the module's own spec comes from the library's codegenConfig.)

In `apps/sandbox/ios/Podfile`, inside the target block add:
```ruby
pod 'ReconcileEngine', :path => '../../../packages/reconcile-engine'
```

- [ ] **Step 4: Build, reconcile generated-header mismatches, run**

```bash
packages/reconcile-engine/scripts/build-ios.sh
cd apps/sandbox/ios && bundle install && bundle exec pod install
cd .. && npx expo run:ios
```
Expected: first attempt likely fails compiling `NativeReconcileEngine.cpp` against the generated `ReconcileEngineSpecJSI.h`. Open the generated header under `ios/build/generated/ios/` (or `Pods/ReconcileEngineSpec`), align method signatures (promise type, emitter name) in the C++ from Task 10, rebuild until the app boots.

Smoke test in `App.tsx` temporarily:
```typescript
import { openEngine, redis } from '@rn-experiments/reconcile-engine';
// in a useEffect:
await openEngine(`${/* app documents dir via expo-file-system */ ''}/engine.sqlite`);
await redis.set('hello', 'world');
console.log(await redis.get('hello')); // "world"
```
Use `expo-file-system` (`npx expo install expo-file-system`) `Paths.document.uri` (strip `file://`) for the DB path.
Expected: Metro logs `world`.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "Wire turbo module into iOS via local pod and module provider"
```

---

### Task 14: Android wiring

**Files:**
- Modify: `apps/sandbox/android/app/build.gradle` (externalNativeBuild)
- Create: `apps/sandbox/android/app/src/main/jni/CMakeLists.txt`
- Create: `apps/sandbox/android/app/src/main/jni/OnLoad.cpp` (copied from RN default then edited)

- [ ] **Step 1: CMakeLists**

`apps/sandbox/android/app/src/main/jni/CMakeLists.txt`:
```cmake
cmake_minimum_required(VERSION 3.13)
project(appmodules)

set(PKG ${CMAKE_SOURCE_DIR}/../../../../../../../packages/reconcile-engine)

include(${REACT_ANDROID_DIR}/cmake-utils/ReactNative-application.cmake)

target_sources(${CMAKE_PROJECT_NAME} PRIVATE ${PKG}/cpp/NativeReconcileEngine.cpp)
target_include_directories(${CMAKE_PROJECT_NAME} PUBLIC ${PKG}/cpp)

add_library(reconcile_engine_rust STATIC IMPORTED)
set_target_properties(reconcile_engine_rust PROPERTIES
  IMPORTED_LOCATION ${PKG}/android-rust/${ANDROID_ABI}/libreconcile_engine.a)
target_link_libraries(${CMAKE_PROJECT_NAME} reconcile_engine_rust)
```

- [ ] **Step 2: OnLoad.cpp**

Copy the default from the installed RN version:
```bash
cp apps/sandbox/node_modules/react-native/ReactAndroid/cmake-utils/default-app-setup/OnLoad.cpp \
   apps/sandbox/android/app/src/main/jni/OnLoad.cpp
```
Edit its `cxxModuleProvider` to:
```cpp
#include <NativeReconcileEngine.h>

std::shared_ptr<TurboModule> cxxModuleProvider(
    const std::string& name,
    const std::shared_ptr<CallInvoker>& jsInvoker) {
  if (name == facebook::react::NativeReconcileEngine::kModuleName) {
    return std::make_shared<facebook::react::NativeReconcileEngine>(jsInvoker);
  }
  return autolinking_cxxModuleProvider(name, jsInvoker);
}
```

- [ ] **Step 3: Gradle**

In `apps/sandbox/android/app/build.gradle`, inside `android { ... }`:
```gradle
externalNativeBuild {
    cmake {
        path "src/main/jni/CMakeLists.txt"
    }
}
```

- [ ] **Step 4: Build and run**

```bash
packages/reconcile-engine/scripts/build-android.sh
cd apps/sandbox && npx expo run:android
```
Expected: same `redis.set/get` smoke test logs `world` on the emulator. Fix header-path/ABI issues as they surface (the relative `PKG` path depth must match the checkout — verify with `ls` from the jni dir).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "Wire turbo module into Android via CMake and OnLoad registration"
```

---

### Task 15: Sandbox screens — Sources & Entries (live via pub/sub)

**Files:**
- Create: `apps/sandbox/src/fixtures.ts`
- Create: `apps/sandbox/src/screens/SourcesScreen.tsx`
- Create: `apps/sandbox/src/screens/EntriesScreen.tsx`
- Modify: `apps/sandbox/App.tsx` (simple two-tab layout — no navigation dependency; a `useState` tab switcher)

**Interfaces:**
- Consumes: full JS API from Task 9.

- [ ] **Step 1: Fixtures**

`src/fixtures.ts`:
```typescript
import type { SourceConfig } from '@rn-experiments/reconcile-engine';

export const SOURCES: SourceConfig[] = [
  { source_id: 'api', format: 'Json', collection: 'people', natural_key_field: 'email', timestamp_field: 'updatedAt', priority: 10 },
  { source_id: 'csv', format: 'Csv', collection: 'people', natural_key_field: 'email', timestamp_field: null, priority: 5 },
  { source_id: 'device', format: 'Json', collection: 'people', natural_key_field: 'email', timestamp_field: null, priority: 20 },
];

export const API_PAYLOAD = JSON.stringify([
  { email: 'ann@x.com', name: 'Ann', city: 'Sydney', updatedAt: 2000 },
  { email: 'bob@x.com', name: 'Bob', city: 'Perth', updatedAt: 2000 },
]);

export const CSV_PAYLOAD = 'email,name,phone\nann@x.com,Annie,0400 111 222\ncarol@x.com,Carol,0400 333 444\n';

export function devicePayload(): string {
  return JSON.stringify([
    { email: 'ann@x.com', lastSeen: new Date().toISOString() },
  ]);
}
```

- [ ] **Step 2: SourcesScreen** — three buttons ("Ingest API JSON", "Import CSV", "Device ping"), each calling `ingest(...)` (CSV via `ingestFile` after writing `CSV_PAYLOAD` to a temp file with expo-file-system, exercising the native file-read path), rendering the returned `BatchSummary` (inserted/updated/unchanged/dead-lettered/skipped) after each press.

```tsx
import React, { useState } from 'react';
import { Button, ScrollView, Text, View } from 'react-native';
import { File, Paths } from 'expo-file-system';
import { ingest, ingestFile, type BatchSummary } from '@rn-experiments/reconcile-engine';
import { API_PAYLOAD, CSV_PAYLOAD, devicePayload } from '../fixtures';

export function SourcesScreen() {
  const [log, setLog] = useState<string[]>([]);
  const report = (label: string, s: BatchSummary) =>
    setLog((l) => [
      `${label}: +${s.inserted} ~${s.updated} =${s.unchanged} !${s.dead_lettered}${s.skipped ? ' (skipped)' : ''}`,
      ...l,
    ]);

  return (
    <ScrollView style={{ padding: 16 }}>
      <Button title="Ingest API JSON" onPress={async () => report('api', await ingest('api', API_PAYLOAD))} />
      <Button
        title="Import CSV (via file)"
        onPress={async () => {
          const f = new File(Paths.cache, 'import.csv');
          f.write(CSV_PAYLOAD);
          report('csv', await ingestFile('csv', f.uri.replace('file://', '')));
        }}
      />
      <Button title="Device ping" onPress={async () => report('device', await ingest('device', devicePayload()))} />
      <View style={{ marginTop: 16 }}>
        {log.map((l, i) => (
          <Text key={i}>{l}</Text>
        ))}
      </View>
    </ScrollView>
  );
}
```
(If the installed expo-file-system version predates the `File/Paths` API, use `FileSystem.cacheDirectory + 'import.csv'` with `writeAsStringAsync` — check `node_modules/expo-file-system/package.json` version and use whichever API it documents.)

- [ ] **Step 3: EntriesScreen** — subscribes to `changes:people`, re-scans and renders all entry hashes:

```tsx
import React, { useCallback, useEffect, useState } from 'react';
import { FlatList, Text, View } from 'react-native';
import { redis, subscribe } from '@rn-experiments/reconcile-engine';

type Row = { key: string; fields: Record<string, string> };

export function EntriesScreen() {
  const [rows, setRows] = useState<Row[]>([]);

  const refresh = useCallback(async () => {
    const keys = await redis.scan('entry:people:*');
    const out: Row[] = [];
    for (const key of keys) {
      out.push({ key, fields: await redis.hgetall(key) });
    }
    setRows(out);
  }, []);

  useEffect(() => {
    void refresh();
    let unsub: (() => void) | undefined;
    void subscribe('changes:people', () => void refresh()).then((u) => (unsub = u));
    return () => unsub?.();
  }, [refresh]);

  return (
    <FlatList
      data={rows}
      keyExtractor={(r) => r.key}
      renderItem={({ item }) => (
        <View style={{ padding: 12, borderBottomWidth: 1 }}>
          <Text style={{ fontWeight: 'bold' }}>{item.key}</Text>
          {Object.entries(item.fields).map(([f, v]) => (
            <Text key={f}>{f}: {v}</Text>
          ))}
        </View>
      )}
    />
  );
}
```

- [ ] **Step 4: App.tsx** — open engine on mount (documents dir + `engine.sqlite`), register all `SOURCES`, call `installFastPath()`, then render a `useState`-based tab bar switching between Sources / Entries / Experiments (Experiments arrives in Task 16 — render a placeholder `<Text>` for now).

- [ ] **Step 5: Manual verification on both platforms**

Run each on iOS sim + Android emulator: press "Ingest API JSON" → Entries updates live (pub/sub → refresh) showing Ann and Bob; press "Import CSV" → Ann gains `phone` but keeps name "Ann" if API `updatedAt` is newer (LWW working — with the fixture timestamps CSV's now-ms is newer, so name becomes "Annie"; confirm which and reason it through against the merge rule); "Device ping" adds `lastSeen`. Press "Ingest API JSON" again → `(skipped)`.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "Add sources and live entries screens to sandbox"
```

---

### Task 16: Experiments screen + BENCHMARKS.md

**Files:**
- Create: `apps/sandbox/src/bench.ts`
- Create: `apps/sandbox/src/screens/ExperimentsScreen.tsx`
- Create: `BENCHMARKS.md` (template, filled from device runs)

**Interfaces:**
- Consumes: `executeRaw`, `executeRawSync`, `global.__reconcileEngine.queryEntriesBuffer/queryEntriesObjects`, `ingest`, `subscribe`.

- [ ] **Step 1: Bench harness**

`src/bench.ts`:
```typescript
import { executeRaw, executeRawSync, ingest, registerSource, subscribe } from '@rn-experiments/reconcile-engine';

declare const global: {
  __reconcileEngine?: {
    queryEntriesBuffer(collection: string): ArrayBuffer;
    queryEntriesObjects(collection: string): Array<{ key: string; fields: Record<string, string> }>;
  };
};

export type BenchResult = { name: string; iterations: number; totalMs: number; perOpMs: number };

async function time(name: string, iterations: number, fn: () => Promise<void> | void): Promise<BenchResult> {
  // warmup
  for (let i = 0; i < Math.min(5, iterations); i++) await fn();
  const t0 = performance.now();
  for (let i = 0; i < iterations; i++) await fn();
  const totalMs = performance.now() - t0;
  return { name, iterations, totalMs, perOpMs: totalMs / iterations };
}

function benchRows(n: number): string {
  const rows = Array.from({ length: n }, (_, i) => ({
    email: `user${i}@bench.com`,
    name: `User ${i}`,
    city: i % 2 ? 'Sydney' : 'Perth',
    score: String(i),
  }));
  return JSON.stringify(rows);
}

export async function runAll(onProgress: (msg: string) => void): Promise<BenchResult[]> {
  const results: BenchResult[] = [];
  const push = async (p: Promise<BenchResult>) => {
    const r = await p;
    results.push(r);
    onProgress(`${r.name}: ${r.perOpMs.toFixed(3)} ms/op`);
  };

  // 1. call overhead
  const ping = JSON.stringify({ cmd: 'get', args: ['__bench_missing__'] });
  await push(time('call-overhead sync', 1000, () => void executeRawSync(ping)));
  await push(time('call-overhead async', 1000, async () => void (await executeRaw(ping))));

  // 2. marshaling at sizes
  await registerSource({
    source_id: 'bench', format: 'Json', collection: 'bench',
    natural_key_field: 'email', timestamp_field: null, priority: 1,
  });
  for (const n of [1000, 10000, 100000]) {
    onProgress(`ingesting ${n} rows...`);
    const t0 = performance.now();
    await ingest('bench', benchRows(n));
    onProgress(`ingest ${n}: ${(performance.now() - t0).toFixed(0)} ms`);

    const iters = n >= 100000 ? 3 : 10;
    await push(time(`query ${n} rows: JSON string`, iters, async () => {
      const resp = await executeRaw(JSON.stringify({ cmd: 'scan', args: ['entry:bench:*'] }));
      JSON.parse(resp);
    }));
    await push(time(`query ${n} rows: JSI objects`, iters, () => {
      global.__reconcileEngine!.queryEntriesObjects('bench');
    }));
    await push(time(`query ${n} rows: ArrayBuffer`, iters, () => {
      const buf = global.__reconcileEngine!.queryEntriesBuffer('bench');
      new Uint8Array(buf); // touch it
    }));
  }

  // 3. change-event latency
  {
    let resolveEvt: (t: number) => void;
    const evt = new Promise<number>((res) => (resolveEvt = res));
    const unsub = await subscribe('changes:bench', () => resolveEvt(performance.now()));
    const t0 = performance.now();
    await ingest('bench', JSON.stringify([{ email: 'evt@bench.com', name: 'Evt', v: String(Math.random()) }]));
    const tEvt = await evt;
    unsub();
    results.push({ name: 'change-event latency', iterations: 1, totalMs: tEvt - t0, perOpMs: tEvt - t0 });
    onProgress(`change-event latency: ${(tEvt - t0).toFixed(1)} ms`);
  }

  return results;
}

export function toMarkdown(platform: string, results: BenchResult[]): string {
  const lines = [
    `### ${platform} — ${new Date().toISOString()}`,
    '',
    '| benchmark | iterations | total ms | ms/op |',
    '|---|---:|---:|---:|',
    ...results.map((r) => `| ${r.name} | ${r.iterations} | ${r.totalMs.toFixed(1)} | ${r.perOpMs.toFixed(3)} |`),
    '',
  ];
  return lines.join('\n');
}
```
Note `Math.random()`/`new Date()` here run in the app, not a workflow — fine.

- [ ] **Step 2: ExperimentsScreen** — "Run benchmarks" button, live progress log, results table, and a "Copy as markdown" button (`import * as Clipboard from 'expo-clipboard'`, `npx expo install expo-clipboard`) that copies `toMarkdown(Platform.OS, results)`.

```tsx
import React, { useState } from 'react';
import { Button, Platform, ScrollView, Text } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { runAll, toMarkdown, type BenchResult } from '../bench';

export function ExperimentsScreen() {
  const [progress, setProgress] = useState<string[]>([]);
  const [results, setResults] = useState<BenchResult[]>([]);
  const [running, setRunning] = useState(false);

  return (
    <ScrollView style={{ padding: 16 }}>
      <Button
        title={running ? 'Running…' : 'Run benchmarks'}
        disabled={running}
        onPress={async () => {
          setRunning(true);
          setProgress([]);
          try {
            setResults(await runAll((m) => setProgress((p) => [...p, m])));
          } finally {
            setRunning(false);
          }
        }}
      />
      {results.length > 0 && (
        <Button
          title="Copy as markdown"
          onPress={() => Clipboard.setStringAsync(toMarkdown(Platform.OS, results))}
        />
      )}
      {progress.map((m, i) => (
        <Text key={i} style={{ fontFamily: 'monospace' }}>{m}</Text>
      ))}
    </ScrollView>
  );
}
```

- [ ] **Step 3: BENCHMARKS.md template**

```markdown
# Turbo Module / Rust Engine Benchmarks

Method: Experiments screen in apps/sandbox, release-ish dev-client build,
physical device where noted. Paste "Copy as markdown" output below per platform.

Assessment matrix coverage:
1. Call overhead (sync vs async)         -> call-overhead rows
2. Marshaling (objects vs JSON vs buffer) -> query N rows
3. Ingest under load                      -> ingest N logs + observed UI frame drops
4. Change-event latency                   -> change-event latency row
5. Cold start                             -> logged at engine open (add console.time around openEngine)
6. iOS vs Android deltas                  -> compare sections

## Results

(paste here)

## Observations

(what the numbers say: where marshaling dominates, where SQLite dominates,
whether the JS thread stayed responsive during 100k ingest, etc.)
```

- [ ] **Step 4: Run on both platforms, paste results, write observations**

Run the suite on iOS simulator + Android emulator (note: simulators ≠ devices; label accordingly). Paste both markdown blocks into `BENCHMARKS.md` and write 5-10 sentences of observations against the assessment matrix.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "Add benchmark harness, experiments screen, and benchmark results"
```

---

### Task 17: README + OSS shape

**Files:**
- Create: `README.md` (root)
- Create: `packages/reconcile-engine/README.md`

- [ ] **Step 1: Root README** — what the experiment is, the architecture diagram from the spec, how to build (rust targets → build scripts → pod install → run), link to BENCHMARKS.md and the spec.

- [ ] **Step 2: Package README** — the Redis-esque API with examples (`redis.set/get/hgetall/scan/expire`, `subscribe`, `registerSource`/`ingest`), the reserved-prefix rule, the wire protocol (`{"cmd","args"}` envelope + binary buffer layout), and an honest "status: experiment, not yet packaged for external consumption" note with the extraction checklist (autolinked library instead of app-level OnLoad registration, prebuilt binaries or build-from-source story, CI).

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "Add READMEs documenting architecture, API, and build"
```
