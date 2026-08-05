use crate::error::EngineError;
use rusqlite::{Connection, OpenFlags};
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

/// Process-wide set of canonical file paths with a live Store (audit S14).
/// Prevents a second engine opening the same file, which would give it an
/// independent write-behind cache and stale cross-connection reads. `:memory:`
/// databases are exempt — each is a distinct, private database.
fn open_paths() -> &'static Mutex<HashSet<PathBuf>> {
    static OPEN_PATHS: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();
    OPEN_PATHS.get_or_init(|| Mutex::new(HashSet::new()))
}

/// Canonical key for the open-path registry. The file may not exist yet, so
/// canonicalize the parent directory and rejoin the file name.
fn canonical_key(path: &str) -> PathBuf {
    let p = std::path::Path::new(path);
    match (p.parent(), p.file_name()) {
        (Some(parent), Some(name)) => match parent.canonicalize() {
            Ok(dir) => dir.join(name),
            Err(_) => p.to_path_buf(),
        },
        _ => p.to_path_buf(),
    }
}

pub struct Store {
    pub(crate) conn: Connection,
    /// Registry key held while open; removed on drop. None for :memory:.
    open_path: Option<PathBuf>,
}

impl Drop for Store {
    fn drop(&mut self) {
        if let Some(key) = self.open_path.take() {
            if let Ok(mut set) = open_paths().lock() {
                set.remove(&key);
            }
        }
    }
}

fn column_exists(conn: &Connection, table: &str, column: &str) -> Result<bool, EngineError> {
    let n: i64 = conn.query_row(
        "SELECT count(*) FROM pragma_table_info(?1) WHERE name = ?2",
        rusqlite::params![table, column],
        |r| r.get(0),
    )?;
    Ok(n > 0)
}

/// Adds a column only if absent, so a re-run after a half-applied migration
/// (audit C3) does not fail with "duplicate column name".
fn add_column_if_missing(conn: &Connection, table: &str, column: &str, decl: &str) -> Result<(), EngineError> {
    if !column_exists(conn, table, column)? {
        conn.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {column} {decl};"))?;
    }
    Ok(())
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

// v2: per-row content hash + meta floor for the reconcile short-circuit.
// content_hash is a structural hash of the fields map; meta_floor_ts /
// meta_floor_pri describe the weakest field meta (min updated_at, and min
// priority among fields at that updated_at) so "could this record advance any
// field's meta?" is answerable without parsing field_meta.
//
// v3: exact stored field count guards the content-hash short-circuit (audit
// F8): a 64-bit hash collision alone can no longer swallow a record that
// introduces a brand-new field. NULL (pre-v3 rows) disables the skip.
//
// Each migration is applied inside a transaction and is idempotent (columns
// are added only if missing), so a process kill mid-migration leaves the DB
// re-openable rather than permanently bricked (audit C3).

impl Store {
    pub fn open(path: &str) -> Result<Store, EngineError> {
        let is_memory = path == ":memory:";
        let registry_key = if is_memory { None } else { Some(canonical_key(path)) };
        // Audit S14: refuse a second open of the same file before touching it.
        if let Some(ref key) = registry_key {
            let mut set = open_paths()
                .lock()
                .map_err(|_| EngineError::Storage("open-path registry poisoned".into()))?;
            if set.contains(key) {
                return Err(EngineError::Storage(format!(
                    "database already open: {}",
                    key.display()
                )));
            }
            set.insert(key.clone());
        }
        // From here, any early return must release the registry entry.
        let result = Self::open_inner(path, is_memory, registry_key.clone());
        if result.is_err() {
            if let Some(ref key) = registry_key {
                if let Ok(mut set) = open_paths().lock() {
                    set.remove(key);
                }
            }
        }
        result
    }

    fn open_inner(path: &str, is_memory: bool, open_path: Option<PathBuf>) -> Result<Store, EngineError> {
        let mut conn = Connection::open(path)?;
        if !is_memory {
            let _mode: String =
                conn.query_row("PRAGMA journal_mode = WAL", [], |r| r.get(0))?;
            // WAL + NORMAL is the standard mobile setting: commits skip the
            // per-transaction fsync (the WAL is synced at checkpoints), which
            // is durable against app crashes; only power loss can drop the
            // most recent commits, never corrupt the DB.
            conn.execute_batch(
                "PRAGMA synchronous = NORMAL;
                 PRAGMA temp_store = MEMORY;",
            )?;
            // Default autocheckpoint (1000 pages = 4 MB) fires mid-benchmark on
            // multi-MB batches, adding run-to-run variance. Checkpoint less
            // often; close runs an explicit truncating checkpoint.
            let _: i64 = conn.query_row("PRAGMA wal_autocheckpoint = 8000", [], |r| r.get(0))?;
        }
        let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        if version == 0 {
            conn.execute_batch(SCHEMA_V1)?;
        }
        if version <= 1 {
            let tx = conn.transaction()?;
            add_column_if_missing(&tx, "entries", "content_hash", "INTEGER")?;
            add_column_if_missing(&tx, "entries", "meta_floor_ts", "INTEGER")?;
            add_column_if_missing(&tx, "entries", "meta_floor_pri", "INTEGER")?;
            tx.pragma_update(None, "user_version", 2)?;
            tx.commit()?;
        }
        if version <= 2 {
            let tx = conn.transaction()?;
            add_column_if_missing(&tx, "entries", "field_count", "INTEGER")?;
            tx.pragma_update(None, "user_version", 3)?;
            tx.commit()?;
        }
        Ok(Store { conn, open_path })
    }

    pub fn user_version(&self) -> Result<i64, EngineError> {
        Ok(self.conn.query_row("PRAGMA user_version", [], |r| r.get(0))?)
    }

    /// A second, **read-only** connection to the same database file.
    ///
    /// WAL already grants one writer and N concurrent readers; the engine was
    /// funnelling both through a single `Connection` behind one mutex, so every
    /// query queued behind whatever ingest happened to be in flight. Measured on
    /// a moto g35: four readers alongside 10k-row ingests dropped the JS thread
    /// to 1.9 fps with a 2.1 s stall, while the same load with no sync readers
    /// held 65 fps — the readers were never slow, only blocked.
    ///
    /// Reads issued here see the last committed snapshot, which is the same
    /// thing they saw before (writes have always been transactional).
    ///
    /// Returns `None` for in-memory databases, where a second connection opens a
    /// *different*, empty database rather than the same one — callers fall back
    /// to the writer connection.
    ///
    /// Note this deliberately bypasses the audit-S14 open-path registry: that
    /// guard exists to stop a second *engine* claiming the same file, and this
    /// is one engine opening a read-only view of a file it already owns.
    pub fn open_read_only(path: &str) -> Option<Connection> {
        if path == ":memory:" || path.is_empty() {
            return None;
        }
        let flags = OpenFlags::SQLITE_OPEN_READ_ONLY
            | OpenFlags::SQLITE_OPEN_NO_MUTEX
            | OpenFlags::SQLITE_OPEN_URI;
        let conn = Connection::open_with_flags(path, flags).ok()?;
        // Sorts and temp b-trees stay off the filesystem, matching the writer.
        // A failure here is not fatal: the connection is still usable.
        let _ = conn.execute_batch("PRAGMA temp_store = MEMORY;");
        Some(conn)
    }
}

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
        assert_eq!(store.user_version().unwrap(), 3);
        // v2 + v3 columns exist
        let cols: i64 = store
            .conn
            .query_row(
                "SELECT count(*) FROM pragma_table_info('entries')
                 WHERE name IN ('content_hash','meta_floor_ts','meta_floor_pri','field_count')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(cols, 4);
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

    // Audit C3: a database left half-migrated (a v2 column already added but
    // user_version still 1, e.g. a process kill between the ALTER and the
    // version bump) must reopen cleanly, not error forever with "duplicate
    // column name".
    #[test]
    fn half_applied_migration_recovers_on_open() {
        let dir = std::env::temp_dir().join("reconcile_engine_test_halfmig");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("db.sqlite");
        let p = path.to_str().unwrap();
        {
            let conn = Connection::open(p).unwrap();
            conn.execute_batch(SCHEMA_V1).unwrap(); // sets user_version = 1
            // simulate a crash mid-v2: one column added, version NOT bumped
            conn.execute_batch("ALTER TABLE entries ADD COLUMN content_hash INTEGER;").unwrap();
            conn.pragma_update(None, "user_version", 1).unwrap();
        }
        // Must not panic/err on the duplicate column; must reach the latest version.
        let store = Store::open(p).unwrap();
        assert_eq!(store.user_version().unwrap(), 3);
        drop(store);
        let _ = std::fs::remove_dir_all(&dir);
    }

    // Audit S14: opening the same file twice would give two engines with
    // independent write-behind caches and stale cross-connection reads.
    #[test]
    fn double_open_same_file_is_rejected() {
        let dir = std::env::temp_dir().join("reconcile_engine_test_doubleopen");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("db.sqlite");
        let p = path.to_str().unwrap();
        let first = Store::open(p).unwrap();
        let second = Store::open(p);
        assert!(second.is_err(), "second open of the same file must be rejected");
        drop(first);
        // after the first closes, opening again succeeds
        let third = Store::open(p);
        assert!(third.is_ok());
        drop(third);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn memory_dbs_are_independent_not_registry_guarded() {
        // Two :memory: opens must both succeed (each is a distinct database).
        let a = Store::open(":memory:").unwrap();
        let b = Store::open(":memory:").unwrap();
        drop(a);
        drop(b);
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
