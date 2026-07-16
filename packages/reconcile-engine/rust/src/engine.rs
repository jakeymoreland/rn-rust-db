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
