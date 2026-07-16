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
