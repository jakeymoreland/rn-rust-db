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

    // Prepared once per batch (and cached on the connection across batches);
    // re-preparing these inside the per-record loop dominated bulk-ingest time.
    {
    let mut sel_stmt = tx.prepare_cached(
        "SELECT fields, field_meta, updated_at FROM entries WHERE collection = ?1 AND natural_key = ?2",
    )?;
    let mut ins_stmt = tx.prepare_cached(
        "INSERT INTO entries(collection, natural_key, fields, field_meta, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
    )?;
    let mut upd_stmt = tx.prepare_cached(
        "UPDATE entries SET fields = ?3, field_meta = ?4, updated_at = ?5
         WHERE collection = ?1 AND natural_key = ?2",
    )?;

    for rec in outcome.records {
        let existing: Option<(String, String, i64)> = sel_stmt
            .query_row(params![rec.collection, rec.natural_key], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
            })
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
                ins_stmt.execute(params![
                    rec.collection,
                    rec.natural_key,
                    serde_json::to_string(&rec.fields).unwrap(),
                    serde_json::to_string(&meta).unwrap(),
                    rec.updated_at
                ])?;
                summary.inserted += 1;
                changed_collections.push(rec.collection.clone());
            }
            Some((fields_json, meta_json, existing_updated_at)) => {
                let mut fields: BTreeMap<String, String> =
                    serde_json::from_str(&fields_json)
                        .map_err(|e| EngineError::Storage(e.to_string()))?;
                let mut meta: BTreeMap<String, FieldMeta> =
                    serde_json::from_str(&meta_json)
                        .map_err(|e| EngineError::Storage(e.to_string()))?;
                let mut dirty = false;
                // `advanced` tracks whether any field won on (timestamp, priority) ordering,
                // even if the winning value happens to equal the current value. Without this,
                // a same-value win would never persist its newer FieldMeta, and a later,
                // genuinely older-but-different value could incorrectly win against it.
                let mut advanced = false;
                for (k, v) in &rec.fields {
                    let wins = match meta.get(k) {
                        None => true,
                        Some(m) => {
                            rec.updated_at > m.updated_at
                                || (rec.updated_at == m.updated_at && cfg.priority > m.priority)
                        }
                    };
                    if wins {
                        advanced = true;
                        if fields.get(k) != Some(v) {
                            fields.insert(k.clone(), v.clone());
                            dirty = true;
                        }
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
                if advanced {
                    // Row-level updated_at must never move backward: a batch that only adds
                    // an older/new field to an already-newer row must not regress the row stamp.
                    let new_updated_at = existing_updated_at.max(rec.updated_at);
                    upd_stmt.execute(params![
                        rec.collection,
                        rec.natural_key,
                        serde_json::to_string(&fields).unwrap(),
                        serde_json::to_string(&meta).unwrap(),
                        new_updated_at
                    ])?;
                    if dirty {
                        summary.updated += 1;
                        changed_collections.push(rec.collection.clone());
                    } else {
                        // Advanced but same value: persisted for correctness (newer FieldMeta),
                        // but nothing visibly changed, so no pub/sub event for this collection.
                        summary.unchanged += 1;
                    }
                } else {
                    summary.unchanged += 1;
                }
            }
        }
    }

    } // statements drop here so tx can commit

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
        let mut en = crate::engine::Engine::open(":memory:", Box::new(|| 0)).unwrap();
        reconcile(&mut en.store, &cfg("api", 10), outcome(vec![rec("api", "a@x.com", "name", "Ann", 100)]), 0).unwrap();
        let keys = crate::commands::scan(&mut en, "entry:people:*", 0).unwrap();
        assert_eq!(keys, vec!["entry:people:a@x.com"]);
    }

    #[test]
    fn row_updated_at_never_regresses() {
        let mut st = Store::open(":memory:").unwrap();
        reconcile(&mut st, &cfg("api", 10), outcome(vec![rec("api", "a@x.com", "name", "Ann", 100)]), 0).unwrap();
        // Second batch only adds a brand-new field with an older record timestamp.
        // The row's updated_at must stay at 100, not regress to 50.
        reconcile(&mut st, &cfg("csv", 5), outcome(vec![rec("csv", "a@x.com", "addr", "123 Main St", 50)]), 0).unwrap();
        let h = crate::commands::hgetall(&st, "entry:people:a@x.com", 0).unwrap();
        assert_eq!(h["_updated_at"], "100");
        assert_eq!(h["addr"], "123 Main St");
    }

    #[test]
    fn same_value_win_advances_meta() {
        let mut st = Store::open(":memory:").unwrap();
        reconcile(&mut st, &cfg("api", 10), outcome(vec![rec("api", "a@x.com", "name", "Ann", 100)]), 0).unwrap();
        // Same value, but wins on newer timestamp with lower priority - must still advance FieldMeta.
        let s = reconcile(&mut st, &cfg("csv", 5), outcome(vec![rec("csv", "a@x.com", "name", "Ann", 150)]), 0).unwrap();
        assert_eq!(s.unchanged, 1);
        assert_eq!(s.updated, 0);
        // A later record with an older timestamp than the persisted 150 must lose,
        // even though its priority differs, proving the meta actually advanced to 150.
        reconcile(&mut st, &cfg("dev", 1), outcome(vec![rec("dev", "a@x.com", "name", "Changed", 120)]), 0).unwrap();
        let h = crate::commands::hgetall(&st, "entry:people:a@x.com", 0).unwrap();
        assert_eq!(h["name"], "Ann");
    }

    #[test]
    fn same_value_win_publishes_no_change() {
        let mut st = Store::open(":memory:").unwrap();
        reconcile(&mut st, &cfg("api", 10), outcome(vec![rec("api", "a@x.com", "name", "Ann", 100)]), 0).unwrap();
        let s = reconcile(&mut st, &cfg("csv", 5), outcome(vec![rec("csv", "a@x.com", "name", "Ann", 150)]), 0).unwrap();
        assert!(s.collections.is_empty());
    }
}
