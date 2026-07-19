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
    /// key -> slot in pending, for last-write-wins coalescing.
    pub pending_index: HashMap<String, usize>,
    /// pending size that triggers a synchronous flush (benchmark-tunable).
    pub high_water: usize,
    /// coalesce repeated sets of one key into a single pending slot.
    pub coalesce: bool,
}

pub struct Engine {
    pub store: Store,
    pub sources: HashMap<String, SourceConfig>,
    pub pubsub: PubSub,
    pub clock: Box<dyn Fn() -> i64 + Send>,
    pub kv: KvCache,
    /// Change events buffered during a command, drained and delivered by the
    /// FFI layer AFTER the engine mutex is released (audit S7) so a subscriber
    /// callback can re-enter the engine without deadlocking.
    pub pending_events: Vec<(String, String)>,
}

impl Engine {
    pub fn open(path: &str, clock: Box<dyn Fn() -> i64 + Send>) -> Result<Engine, EngineError> {
        Ok(Engine {
            store: Store::open(path)?,
            sources: HashMap::new(),
            pubsub: PubSub::new(),
            clock,
            kv: KvCache {
                map: HashMap::new(),
                ttl: HashMap::new(),
                pending: Vec::new(),
                pending_index: HashMap::new(),
                high_water: 256,
                coalesce: true,
            },
            pending_events: Vec::new(),
        })
    }

    /// Drains change events buffered by the last command. Called by the FFI
    /// layer after the engine mutex is released so the sink runs lock-free.
    pub fn take_events(&mut self) -> Vec<(String, String)> {
        std::mem::take(&mut self.pending_events)
    }

    /// Drains pending kv sets into SQLite in one transaction. Each set also
    /// clears any key_ttl row, matching redis SET semantics; commands that
    /// apply a TTL after a set flush first, so ordering is preserved.
    pub fn flush_kv(&mut self) -> Result<(), EngineError> {
        if self.kv.pending.is_empty() {
            return Ok(());
        }
        let pending = std::mem::take(&mut self.kv.pending);
        self.kv.pending_index.clear();
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
            self.kv.pending_index.clear();
            for (i, (k, _)) in self.kv.pending.iter().enumerate() {
                self.kv.pending_index.insert(k.clone(), i);
            }
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

        // Audit S15: fold the source config into the skip fingerprint, so
        // re-registering a source with different merge rules (priority, key,
        // collection) never lets a byte-identical payload hit the skip.
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        payload.hash(&mut hasher);
        serde_json::to_string(&cfg).unwrap_or_default().hash(&mut hasher);
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
                    timings: None,
                },
                true,
            ));
        }

        let t_parse = std::time::Instant::now();
        let outcome = normalize(&cfg, payload, now)?;
        let parse_ms = t_parse.elapsed().as_secs_f64() * 1000.0;
        // Audit S6: content_hash is written inside reconcile's transaction, so
        // a committed batch always has its skip fingerprint (and no post-commit
        // step can fail and swallow the change events).
        let mut summary = reconcile(&mut self.store, &cfg, outcome, now, &content_hash)?;
        if let Some(t) = summary.timings.as_mut() {
            t.parse_ms = parse_ms;
        }
        let summary = summary;
        // Audit S7: buffer events instead of firing the sink here (under the
        // engine lock). The FFI layer delivers them after releasing the lock.
        if !summary.collections.is_empty() {
            let payload_json = serde_json::to_string(&summary).unwrap();
            for c in &summary.collections {
                let channel = format!("changes:{c}");
                if self.pubsub.any_match(&channel) {
                    self.pending_events.push((channel, payload_json.clone()));
                }
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
