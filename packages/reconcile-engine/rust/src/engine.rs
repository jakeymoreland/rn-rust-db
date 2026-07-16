use crate::error::EngineError;
use crate::normalize::{normalize, SourceConfig};
use crate::pubsub::PubSub;
use crate::reconcile::{reconcile, BatchSummary};
use crate::store::Store;
use rusqlite::params;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};

/// Write-behind cache for the kv table. Reads and writes hit these maps under
/// the engine mutex; `pending` holds sets not yet flushed to SQLite. Flushes
/// happen when pending grows past a bound, before any command that reads the
/// kv/key_ttl tables directly, every ~100 ms from the FFI flusher thread, and
/// on close.
pub struct KvCache {
    pub map: HashMap<String, String>,
    /// expires_at for keys this session knows have TTLs (mirrors key_ttl).
    pub ttl: HashMap<String, i64>,
    pub pending: Vec<(String, String)>,
}

pub struct Engine {
    pub store: Store,
    pub sources: HashMap<String, SourceConfig>,
    pub pubsub: PubSub,
    pub clock: Box<dyn Fn() -> i64 + Send>,
    pub kv: KvCache,
}

impl Engine {
    pub fn open(path: &str, clock: Box<dyn Fn() -> i64 + Send>) -> Result<Engine, EngineError> {
        Ok(Engine {
            store: Store::open(path)?,
            sources: HashMap::new(),
            pubsub: PubSub::new(),
            clock,
            kv: KvCache { map: HashMap::new(), ttl: HashMap::new(), pending: Vec::new() },
        })
    }

    /// Drains pending kv sets into SQLite in one transaction. Each set also
    /// clears any key_ttl row, matching redis SET semantics; commands that
    /// apply a TTL after a set flush first, so ordering is preserved.
    pub fn flush_kv(&mut self) -> Result<(), EngineError> {
        if self.kv.pending.is_empty() {
            return Ok(());
        }
        let pending = std::mem::take(&mut self.kv.pending);
        let result = (|| -> Result<(), EngineError> {
            let tx = self.store.conn.transaction()?;
            {
                let mut ins = tx.prepare_cached(
                    "INSERT INTO kv(key, value) VALUES (?1, ?2)
                     ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                )?;
                let mut del_ttl = tx.prepare_cached("DELETE FROM key_ttl WHERE key = ?1")?;
                for (k, v) in &pending {
                    ins.execute(params![k, v])?;
                    del_ttl.execute(params![k])?;
                }
            }
            tx.commit()?;
            Ok(())
        })();
        if result.is_err() {
            // keep the writes queued so a later flush can retry
            let mut restored = pending;
            restored.extend(std::mem::take(&mut self.kv.pending));
            self.kv.pending = restored;
        }
        result
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
