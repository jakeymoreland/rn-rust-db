use crate::error::EngineError;
use crate::normalize::{CanonicalRecord, NormalizeOutcome, SourceConfig};
use crate::store::Store;
use rusqlite::params;
use serde::Serialize;
use std::collections::{BTreeMap, HashMap};

#[derive(Debug, Serialize, PartialEq, Clone, Copy)]
pub struct IngestTimings {
    pub parse_ms: f64,
    pub prefetch_ms: f64,
    pub merge_ms: f64,
    pub write_ms: f64,
    pub commit_ms: f64,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct BatchSummary {
    pub inserted: u32,
    pub updated: u32,
    pub unchanged: u32,
    pub dead_lettered: u32,
    pub collections: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timings: Option<IngestTimings>,
}

#[derive(Serialize, serde::Deserialize, Clone)]
struct FieldMeta {
    source: String,
    updated_at: i64,
    priority: u32,
}

#[derive(Clone)]
struct ExistingRow {
    fields_json: String,
    meta_json: String,
    updated_at: i64,
    // v2/v3 short-circuit columns; None on rows written before the migrations.
    content_hash: Option<i64>,
    meta_floor_ts: Option<i64>,
    meta_floor_pri: Option<i64>,
    field_count: Option<i64>,
}

/// Compact on-disk form of field_meta. In almost every batch, all fields of a
/// row share identical meta (they arrived together), so store one default
/// plus per-field exceptions: ~60 B instead of ~1.2 KB of per-field JSON.
/// Legacy rows (a plain field->meta map) fail this parse and fall back.
#[derive(Serialize, serde::Deserialize)]
struct CompactMeta {
    v: u8,
    d: FieldMeta,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    o: BTreeMap<String, FieldMeta>,
}

/// Parses either meta format into the expanded per-field map the merge logic
/// operates on. Compact expansion covers the union of the row's field names
/// and any override keys.
fn parse_meta(
    meta_json: &str,
    fields: &BTreeMap<String, String>,
) -> Result<BTreeMap<String, FieldMeta>, EngineError> {
    if let Ok(c) = serde_json::from_str::<CompactMeta>(meta_json) {
        let mut out: BTreeMap<String, FieldMeta> = BTreeMap::new();
        for k in fields.keys() {
            out.insert(k.clone(), c.d.clone());
        }
        for (k, m) in c.o {
            out.insert(k, m);
        }
        return Ok(out);
    }
    serde_json::from_str(meta_json).map_err(|e| EngineError::Storage(e.to_string()))
}

/// Serializes the expanded meta map compactly: the modal (source, ts, pri)
/// triple becomes the default; everything else is an override.
fn serialize_meta_compact(meta: &BTreeMap<String, FieldMeta>) -> String {
    let mut counts: HashMap<(&str, i64, u32), usize> = HashMap::new();
    for m in meta.values() {
        *counts.entry((m.source.as_str(), m.updated_at, m.priority)).or_default() += 1;
    }
    let Some((&(src, ts, pri), _)) = counts.iter().max_by_key(|(_, n)| **n) else {
        return "{\"v\":2,\"d\":{\"source\":\"\",\"updated_at\":0,\"priority\":0}}".into();
    };
    let d = FieldMeta { source: src.to_string(), updated_at: ts, priority: pri };
    let o: BTreeMap<String, FieldMeta> = meta
        .iter()
        .filter(|(_, m)| m.source != d.source || m.updated_at != d.updated_at || m.priority != d.priority)
        .map(|(k, m)| (k.clone(), m.clone()))
        .collect();
    serde_json::to_string(&CompactMeta { v: 2, d, o }).unwrap()
}

/// Structural hash of the canonical fields map (BTreeMap order is stable), so
/// content equality checks need no serialization.
fn fields_hash(fields: &BTreeMap<String, String>) -> i64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    for (k, v) in fields {
        k.hash(&mut h);
        v.hash(&mut h);
    }
    h.finish() as i64
}

/// The weakest field meta: (min updated_at, min priority among fields at that
/// updated_at). A record that cannot beat the floor cannot advance ANY field.
fn meta_floor(meta: &BTreeMap<String, FieldMeta>) -> (i64, i64) {
    let floor_ts = meta.values().map(|m| m.updated_at).min().unwrap_or(i64::MIN);
    let floor_pri = meta
        .values()
        .filter(|m| m.updated_at == floor_ts)
        .map(|m| m.priority as i64)
        .min()
        .unwrap_or(0);
    (floor_ts, floor_pri)
}

struct WriteRow {
    is_insert: bool,
    fields_json: String,
    meta_json: String,
    updated_at: i64,
    content_hash: i64,
    floor_ts: i64,
    floor_pri: i64,
    field_count: i64,
}

struct GroupOutcome {
    collection: String,
    natural_key: String,
    inserted: u32,
    updated: u32,
    unchanged: u32,
    visibly_changed: bool,
    write: Option<WriteRow>,
}

/// A group's in-flight row state: (fields, per-field merge meta, row updated_at).
type RowState = (BTreeMap<String, String>, BTreeMap<String, FieldMeta>, i64);

/// Folds all of one key's records into its final row state, entirely in RAM.
/// The DB row is parsed at most once per group (and not at all when the hash
/// short-circuit fires on the first record); the final state serializes once.
fn merge_group(
    cfg: &SourceConfig,
    db_row: Option<ExistingRow>,
    ((collection, natural_key), recs): ((String, String), Vec<CanonicalRecord>),
) -> Result<GroupOutcome, EngineError> {
    let was_insert = db_row.is_none();
    let mut inserted = 0u32;
    let mut updated = 0u32;
    let mut unchanged = 0u32;
    let mut visibly_changed = false;
    let mut wrote = false;
    // None until inserted or parsed from db_row
    let mut state: Option<RowState> = None;

    for rec in recs {
        if state.is_none() && db_row.is_none() {
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
            state = Some((rec.fields, meta, rec.updated_at));
            inserted += 1;
            visibly_changed = true;
            wrote = true;
            continue;
        }
        if state.is_none() {
            let row = db_row.as_ref().unwrap();
            // Short-circuit (valid only against the pristine DB row):
            // identical content AND the record cannot beat the meta floor
            // means no field's value or meta could change — skip the parse.
            // The exact field count guards against a 64-bit hash collision
            // swallowing a record that introduces a new field (audit F8).
            if let (Some(h), Some(floor_ts), Some(floor_pri), Some(fc)) =
                (row.content_hash, row.meta_floor_ts, row.meta_floor_pri, row.field_count)
            {
                let cannot_advance = rec.updated_at < floor_ts
                    || (rec.updated_at == floor_ts && (cfg.priority as i64) <= floor_pri);
                if cannot_advance
                    && fields_hash(&rec.fields) == h
                    && fc == rec.fields.len() as i64
                {
                    unchanged += 1;
                    continue;
                }
            }
            let fields: BTreeMap<String, String> = serde_json::from_str(&row.fields_json)
                .map_err(|e| EngineError::Storage(e.to_string()))?;
            let meta = parse_meta(&row.meta_json, &fields)?;
            state = Some((fields, meta, row.updated_at));
        }
        let (fields, meta, row_ts) = state.as_mut().unwrap();
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
                    // Exact tie from the SAME source is a correction in batch
                    // order — the incoming record wins (audit S2). Cross-source
                    // exact ties keep the existing value for stability.
                    rec.updated_at > m.updated_at
                        || (rec.updated_at == m.updated_at
                            && (cfg.priority > m.priority
                                || (cfg.priority == m.priority && m.source == rec.source)))
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
            *row_ts = (*row_ts).max(rec.updated_at);
            wrote = true;
            if dirty {
                updated += 1;
                visibly_changed = true;
            } else {
                // Advanced but same value: persisted for correctness (newer FieldMeta),
                // but nothing visibly changed, so no pub/sub event for this collection.
                unchanged += 1;
            }
        } else {
            unchanged += 1;
        }
    }

    let write = if wrote {
        let (fields, meta, updated_at) = state.unwrap();
        let (floor_ts, floor_pri) = meta_floor(&meta);
        Some(WriteRow {
            is_insert: was_insert,
            fields_json: serde_json::to_string(&fields).unwrap(),
            meta_json: serialize_meta_compact(&meta),
            updated_at,
            content_hash: fields_hash(&fields),
            floor_ts,
            floor_pri,
            field_count: fields.len() as i64,
        })
    } else {
        None
    };
    Ok(GroupOutcome { collection, natural_key, inserted, updated, unchanged, visibly_changed, write })
}

pub fn reconcile(
    store: &mut Store,
    cfg: &SourceConfig,
    outcome: NormalizeOutcome,
    now_ms: i64,
    content_hash: &str,
) -> Result<BatchSummary, EngineError> {
    let tx = store.conn.transaction()?;
    let mut summary = BatchSummary {
        inserted: 0,
        updated: 0,
        unchanged: 0,
        dead_lettered: 0,
        collections: vec![],
        timings: None,
    };
    let mut timings = IngestTimings { parse_ms: 0.0, prefetch_ms: 0.0, merge_ms: 0.0, write_ms: 0.0, commit_ms: 0.0 };
    let t_prefetch = std::time::Instant::now();
    let mut changed_collections: Vec<String> = vec![];

    // Bulk-prefetch existing rows for the whole batch: one chunked
    // SELECT ... IN (...) per collection instead of one B-tree probe per
    // record. The map is written back after every merge so a batch containing
    // the same key twice still sees its own earlier writes.
    let mut existing_map: HashMap<(String, String), ExistingRow> = HashMap::new();
    {
        let mut by_collection: HashMap<&str, Vec<&str>> = HashMap::new();
        for rec in &outcome.records {
            by_collection
                .entry(rec.collection.as_str())
                .or_default()
                .push(rec.natural_key.as_str());
        }
        for (collection, keys) in by_collection {
            for chunk in keys.chunks(900) {
                let placeholders = vec!["?"; chunk.len()].join(",");
                let sql = format!(
                    "SELECT natural_key, fields, field_meta, updated_at, content_hash, meta_floor_ts, meta_floor_pri, field_count
                     FROM entries WHERE collection = ? AND natural_key IN ({placeholders})"
                );
                let mut stmt = tx.prepare(&sql)?;
                let mut rows = stmt.query(rusqlite::params_from_iter(
                    std::iter::once(collection).chain(chunk.iter().copied()),
                ))?;
                while let Some(row) = rows.next()? {
                    existing_map.insert(
                        (collection.to_string(), row.get::<_, String>(0)?),
                        ExistingRow {
                            fields_json: row.get(1)?,
                            meta_json: row.get(2)?,
                            updated_at: row.get(3)?,
                            content_hash: row.get(4)?,
                            meta_floor_ts: row.get(5)?,
                            meta_floor_pri: row.get(6)?,
                            field_count: row.get(7)?,
                        },
                    );
                }
            }
        }
    }

    timings.prefetch_ms = t_prefetch.elapsed().as_secs_f64() * 1000.0;
    let t_merge = std::time::Instant::now();

    // Group records by key (first-occurrence order, duplicates folded
    // sequentially inside their group), then merge groups in RAM — in
    // parallel for large batches, since each group owns its key exclusively
    // and the prefetch map is read-only from here.
    let mut group_index: HashMap<(String, String), usize> = HashMap::new();
    let mut groups: Vec<((String, String), Vec<CanonicalRecord>)> = Vec::new();
    for rec in outcome.records {
        let key = (rec.collection.clone(), rec.natural_key.clone());
        match group_index.get(&key) {
            Some(&i) => groups[i].1.push(rec),
            None => {
                group_index.insert(key.clone(), groups.len());
                groups.push((key, vec![rec]));
            }
        }
    }

    // Overridable for perf experiments (RECONCILE_PAR_THRESHOLD=0 disables
    // parallelism entirely; usize::MAX effectively, since 0 parses as "off").
    let parallel_threshold: usize = std::env::var("RECONCILE_PAR_THRESHOLD")
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .map(|v| if v == 0 { usize::MAX } else { v })
        .unwrap_or(128);
    let outcomes: Vec<Result<GroupOutcome, EngineError>> = if groups.len() >= parallel_threshold {
        use rayon::prelude::*;
        groups
            .into_par_iter()
            .map(|g| merge_group(cfg, existing_map.get(&g.0).cloned(), g))
            .collect()
    } else {
        groups
            .into_iter()
            .map(|g| merge_group(cfg, existing_map.get(&g.0).cloned(), g))
            .collect()
    };

    timings.merge_ms = t_merge.elapsed().as_secs_f64() * 1000.0;
    let t_write = std::time::Instant::now();

    // Sequential write pass: one prepared INSERT or UPDATE per group that
    // actually changed (a group merged N times still writes once).
    {
        let mut ins_stmt = tx.prepare_cached(
            "INSERT INTO entries(collection, natural_key, fields, field_meta, updated_at, content_hash, meta_floor_ts, meta_floor_pri, field_count)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        )?;
        let mut upd_stmt = tx.prepare_cached(
            "UPDATE entries SET fields = ?3, field_meta = ?4, updated_at = ?5, content_hash = ?6, meta_floor_ts = ?7, meta_floor_pri = ?8, field_count = ?9
             WHERE collection = ?1 AND natural_key = ?2",
        )?;
        for oc in outcomes {
            let oc = oc?;
            summary.inserted += oc.inserted;
            summary.updated += oc.updated;
            summary.unchanged += oc.unchanged;
            if oc.visibly_changed {
                changed_collections.push(oc.collection.clone());
            }
            if let Some(w) = oc.write {
                let stmt = if w.is_insert { &mut ins_stmt } else { &mut upd_stmt };
                stmt.execute(params![
                    oc.collection,
                    oc.natural_key,
                    w.fields_json,
                    w.meta_json,
                    w.updated_at,
                    w.content_hash,
                    w.floor_ts,
                    w.floor_pri,
                    w.field_count
                ])?;
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
    // Audit S13: cap the quarantine per source (newest 1000 kept) inside the
    // same transaction — a persistently-broken source can no longer grow the
    // DB without bound.
    if summary.dead_lettered > 0 {
        tx.execute(
            "DELETE FROM dead_letter WHERE source = ?1 AND id NOT IN (
               SELECT id FROM dead_letter WHERE source = ?1 ORDER BY id DESC LIMIT 1000)",
            params![cfg.source_id],
        )?;
    }

    // Audit S6: the source's content_hash is written in THIS transaction with
    // the row changes, not a separate post-commit UPDATE that could fail and
    // leave a committed batch with no skip fingerprint (and no change event).
    tx.execute(
        "INSERT INTO sync_meta(source, last_sync, content_hash) VALUES (?1, ?2, ?3)
         ON CONFLICT(source) DO UPDATE SET last_sync = excluded.last_sync, content_hash = excluded.content_hash",
        params![cfg.source_id, now_ms, content_hash],
    )?;

    timings.write_ms = t_write.elapsed().as_secs_f64() * 1000.0;
    let t_commit = std::time::Instant::now();
    tx.commit()?;
    timings.commit_ms = t_commit.elapsed().as_secs_f64() * 1000.0;
    summary.timings = Some(timings);
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
    fn large_batches_take_the_parallel_path() {
        let mut st = Store::open(":memory:").unwrap();
        // 300 groups > PARALLEL_THRESHOLD — insert wave, then an update wave
        let inserts: Vec<CanonicalRecord> =
            (0..300).map(|i| rec("api", &format!("u{i}@x.com"), "name", "A", 100)).collect();
        let s = reconcile(&mut st, &cfg("api", 10), outcome(inserts), 0, "h").unwrap();
        assert_eq!(s.inserted, 300);
        let updates: Vec<CanonicalRecord> = (0..300)
            .map(|i| rec("api", &format!("u{i}@x.com"), "name", if i % 2 == 0 { "B" } else { "A" }, 200))
            .collect();
        let s = reconcile(&mut st, &cfg("api", 10), outcome(updates), 0, "h").unwrap();
        assert_eq!(s.updated, 150);
        assert_eq!(s.unchanged, 150); // same value, newer ts: advanced-not-dirty
        let n: i64 = st
            .conn
            .query_row("SELECT count(*) FROM entries WHERE fields LIKE '%\"B\"%'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 150);
    }

    #[test]
    fn legacy_meta_rows_still_merge() {
        let mut st = Store::open(":memory:").unwrap();
        // simulate a pre-migration row: legacy map-format meta, NULL v2 columns
        st.conn
            .execute(
                "INSERT INTO entries(collection, natural_key, fields, field_meta, updated_at)
                 VALUES ('people', 'old@x.com',
                         '{\"email\":\"old@x.com\",\"name\":\"Old\"}',
                         '{\"email\":{\"source\":\"api\",\"updated_at\":50,\"priority\":10},\"name\":{\"source\":\"api\",\"updated_at\":50,\"priority\":10}}',
                         50)",
                [],
            )
            .unwrap();
        // newer value must win over the legacy row (no short-circuit possible:
        // hash columns are NULL)
        let s = reconcile(&mut st, &cfg("api", 10), outcome(vec![rec("api", "old@x.com", "name", "New", 100)]), 0, "h").unwrap();
        assert_eq!(s.updated, 1);
        let (fields, meta): (String, String) = st
            .conn
            .query_row(
                "SELECT fields, field_meta FROM entries WHERE natural_key='old@x.com'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert!(fields.contains("New"), "{fields}");
        // rewritten in compact format with backfilled hash columns
        assert!(meta.contains("\"v\":2"), "{meta}");
        let hash: Option<i64> = st
            .conn
            .query_row("SELECT content_hash FROM entries WHERE natural_key='old@x.com'", [], |r| r.get(0))
            .unwrap();
        assert!(hash.is_some());
    }

    #[test]
    fn hash_short_circuit_never_blocks_meta_advance() {
        let mut st = Store::open(":memory:").unwrap();
        // source A (pri 10) writes the value at ts 100
        reconcile(&mut st, &cfg("a", 10), outcome(vec![rec("a", "k@x.com", "name", "Ann", 100)]), 0, "h").unwrap();
        // identical content, same ts, LOWER priority: short-circuit is sound (cannot advance)
        let s = reconcile(&mut st, &cfg("low", 5), outcome(vec![rec("low", "k@x.com", "name", "Ann", 100)]), 0, "h").unwrap();
        assert_eq!(s.unchanged, 1);
        // identical content, same ts, HIGHER priority: must take the full path
        // and persist the newer meta (source b, pri 20), even though nothing
        // visibly changed
        let s = reconcile(&mut st, &cfg("b", 20), outcome(vec![rec("b", "k@x.com", "name", "Ann", 100)]), 0, "h").unwrap();
        assert_eq!(s.unchanged, 1);
        let meta: String = st
            .conn
            .query_row("SELECT field_meta FROM entries WHERE natural_key='k@x.com'", [], |r| r.get(0))
            .unwrap();
        assert!(meta.contains("\"b\""), "meta advance was skipped: {meta}");
        // now a same-ts pri-15 DIFFERENT value must lose against pri-20 meta
        let s = reconcile(&mut st, &cfg("c", 15), outcome(vec![rec("c", "k@x.com", "name", "Evil", 100)]), 0, "h").unwrap();
        assert_eq!(s.updated, 0);
        let fields: String = st
            .conn
            .query_row("SELECT fields FROM entries WHERE natural_key='k@x.com'", [], |r| r.get(0))
            .unwrap();
        assert!(fields.contains("Ann"), "lower-priority value overwrote: {fields}");
    }

    #[test]
    fn same_key_twice_in_one_batch_sees_earlier_merge() {
        let mut st = Store::open(":memory:").unwrap();
        // first record inserts; second (same key, newer ts, different field
        // value) must merge against the FIRST record's state, not the empty DB
        let s = reconcile(
            &mut st,
            &cfg("api", 10),
            outcome(vec![
                rec("api", "a@x.com", "name", "Ann", 100),
                rec("api", "a@x.com", "name", "Annie", 200),
            ]),
            0,
            "h",
        )
        .unwrap();
        assert_eq!(s.inserted, 1);
        assert_eq!(s.updated, 1);
        let fields: String = st
            .conn
            .query_row(
                "SELECT fields FROM entries WHERE collection='people' AND natural_key='a@x.com'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(fields.contains("Annie"), "second record's merge lost: {fields}");
    }

    #[test]
    fn insert_then_read_via_redis_surface() {
        let mut st = Store::open(":memory:").unwrap();
        let s = reconcile(&mut st, &cfg("api", 10), outcome(vec![rec("api", "a@x.com", "name", "Ann", 100)]), 0, "h").unwrap();
        assert_eq!(s.inserted, 1);
        assert_eq!(s.collections, vec!["people".to_string()]);
        let h = crate::commands::hgetall(&st, "entry:people:a@x.com", 0).unwrap();
        assert_eq!(h["name"], "Ann");
        assert_eq!(h["_updated_at"], "100");
    }

    #[test]
    fn newer_timestamp_wins_per_field() {
        let mut st = Store::open(":memory:").unwrap();
        reconcile(&mut st, &cfg("api", 10), outcome(vec![rec("api", "a@x.com", "name", "Ann", 100)]), 0, "h").unwrap();
        let s = reconcile(&mut st, &cfg("csv", 5), outcome(vec![rec("csv", "a@x.com", "name", "Annie", 200)]), 0, "h").unwrap();
        assert_eq!(s.updated, 1);
        let h = crate::commands::hgetall(&st, "entry:people:a@x.com", 0).unwrap();
        assert_eq!(h["name"], "Annie");
    }

    #[test]
    fn older_timestamp_loses_higher_priority_ties_win() {
        let mut st = Store::open(":memory:").unwrap();
        reconcile(&mut st, &cfg("api", 10), outcome(vec![rec("api", "a@x.com", "name", "Ann", 100)]), 0, "h").unwrap();
        // older -> loses
        let s1 = reconcile(&mut st, &cfg("csv", 99), outcome(vec![rec("csv", "a@x.com", "name", "Old", 50)]), 0, "h").unwrap();
        assert_eq!(s1.unchanged, 1);
        // same ts, higher priority -> wins
        reconcile(&mut st, &cfg("dev", 20), outcome(vec![rec("dev", "a@x.com", "name", "Tie", 100)]), 0, "h").unwrap();
        let h = crate::commands::hgetall(&st, "entry:people:a@x.com", 0).unwrap();
        assert_eq!(h["name"], "Tie");
    }

    #[test]
    fn fields_merge_across_sources() {
        let mut st = Store::open(":memory:").unwrap();
        reconcile(&mut st, &cfg("api", 10), outcome(vec![rec("api", "a@x.com", "name", "Ann", 100)]), 0, "h").unwrap();
        reconcile(&mut st, &cfg("csv", 5), outcome(vec![rec("csv", "a@x.com", "phone", "555", 100)]), 0, "h").unwrap();
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
        let s = reconcile(&mut st, &cfg("api", 10), out, 123, "h").unwrap();
        assert_eq!(s.inserted, 1);
        assert_eq!(s.dead_lettered, 1);
        let n: i64 = st.conn.query_row("SELECT count(*) FROM dead_letter", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
    }

    #[test]
    fn identical_reingest_is_unchanged() {
        let mut st = Store::open(":memory:").unwrap();
        reconcile(&mut st, &cfg("api", 10), outcome(vec![rec("api", "a@x.com", "name", "Ann", 100)]), 0, "h").unwrap();
        let s = reconcile(&mut st, &cfg("api", 10), outcome(vec![rec("api", "a@x.com", "name", "Ann", 100)]), 0, "h").unwrap();
        assert_eq!(s.unchanged, 1);
        assert!(s.collections.is_empty());
    }

    #[test]
    fn scan_sees_entry_virtual_keys() {
        let mut en = crate::engine::Engine::open(":memory:", Box::new(|| 0)).unwrap();
        reconcile(&mut en.store, &cfg("api", 10), outcome(vec![rec("api", "a@x.com", "name", "Ann", 100)]), 0, "h").unwrap();
        let keys = crate::commands::scan(&mut en, "entry:people:*", 0).unwrap();
        assert_eq!(keys, vec!["entry:people:a@x.com"]);
    }

    #[test]
    fn row_updated_at_never_regresses() {
        let mut st = Store::open(":memory:").unwrap();
        reconcile(&mut st, &cfg("api", 10), outcome(vec![rec("api", "a@x.com", "name", "Ann", 100)]), 0, "h").unwrap();
        // Second batch only adds a brand-new field with an older record timestamp.
        // The row's updated_at must stay at 100, not regress to 50.
        reconcile(&mut st, &cfg("csv", 5), outcome(vec![rec("csv", "a@x.com", "addr", "123 Main St", 50)]), 0, "h").unwrap();
        let h = crate::commands::hgetall(&st, "entry:people:a@x.com", 0).unwrap();
        assert_eq!(h["_updated_at"], "100");
        assert_eq!(h["addr"], "123 Main St");
    }

    #[test]
    fn same_value_win_advances_meta() {
        let mut st = Store::open(":memory:").unwrap();
        reconcile(&mut st, &cfg("api", 10), outcome(vec![rec("api", "a@x.com", "name", "Ann", 100)]), 0, "h").unwrap();
        // Same value, but wins on newer timestamp with lower priority - must still advance FieldMeta.
        let s = reconcile(&mut st, &cfg("csv", 5), outcome(vec![rec("csv", "a@x.com", "name", "Ann", 150)]), 0, "h").unwrap();
        assert_eq!(s.unchanged, 1);
        assert_eq!(s.updated, 0);
        // A later record with an older timestamp than the persisted 150 must lose,
        // even though its priority differs, proving the meta actually advanced to 150.
        reconcile(&mut st, &cfg("dev", 1), outcome(vec![rec("dev", "a@x.com", "name", "Changed", 120)]), 0, "h").unwrap();
        let h = crate::commands::hgetall(&st, "entry:people:a@x.com", 0).unwrap();
        assert_eq!(h["name"], "Ann");
    }

    // Audit S2: an exact tie (same ts, same priority) from the SAME source is
    // a correction in batch order — the later record must win. Cross-source
    // exact ties keep the existing value (stability).
    #[test]
    fn exact_tie_same_source_last_writer_wins() {
        let mut st = Store::open(":memory:").unwrap();
        let s = reconcile(
            &mut st,
            &cfg("api", 10),
            outcome(vec![
                rec("api", "a@x.com", "name", "Ann", 100),
                rec("api", "a@x.com", "name", "Corrected", 100),
            ]),
            0,
            "h",
        )
        .unwrap();
        assert_eq!(s.inserted, 1);
        let h = crate::commands::hgetall(&st, "entry:people:a@x.com", 0).unwrap();
        assert_eq!(h["name"], "Corrected", "same-source tie discarded the correction");
    }

    #[test]
    fn exact_tie_cross_source_keeps_existing() {
        let mut st = Store::open(":memory:").unwrap();
        reconcile(&mut st, &cfg("api", 10), outcome(vec![rec("api", "a@x.com", "name", "Ann", 100)]), 0, "h").unwrap();
        let s = reconcile(&mut st, &cfg("other", 10), outcome(vec![rec("other", "a@x.com", "name", "Intruder", 100)]), 0, "h").unwrap();
        assert_eq!(s.updated, 0);
        let h = crate::commands::hgetall(&st, "entry:people:a@x.com", 0).unwrap();
        assert_eq!(h["name"], "Ann");
    }

    // Audit F8: a content-hash collision must not swallow a record that
    // introduces a brand-new field — the stored field count guards the skip.
    #[test]
    fn hash_collision_with_new_field_still_stores_it() {
        let mut st = Store::open(":memory:").unwrap();
        reconcile(&mut st, &cfg("api", 10), outcome(vec![rec("api", "a@x.com", "name", "Ann", 100)]), 0, "h").unwrap();
        // Build an incoming record with an EXTRA field, then force the stored
        // content_hash to collide with it (simulating the 2^-64 case).
        let mut extra = rec("api", "a@x.com", "name", "Ann", 50); // old ts: cannot_advance
        extra.fields.insert("nickname".into(), "Nan".into());
        let forged = fields_hash(&extra.fields);
        st.conn
            .execute("UPDATE entries SET content_hash = ?1 WHERE natural_key = 'a@x.com'", params![forged])
            .unwrap();
        reconcile(&mut st, &cfg("api", 10), outcome(vec![extra]), 0, "h").unwrap();
        let h = crate::commands::hgetall(&st, "entry:people:a@x.com", 0).unwrap();
        assert_eq!(h["nickname"], "Nan", "colliding hash swallowed the new field");
    }

    // Audit S13: dead_letter is capped per source; oldest rows pruned in-tx.
    #[test]
    fn dead_letter_capped_at_1000_per_source() {
        let mut st = Store::open(":memory:").unwrap();
        for wave in 0..2 {
            let rejects: Vec<(String, String)> =
                (0..600).map(|i| (format!("frag-{wave}-{i}"), "bad".into())).collect();
            let out = NormalizeOutcome { records: vec![], rejects };
            reconcile(&mut st, &cfg("api", 10), out, wave, "h").unwrap();
        }
        let n: i64 = st.conn.query_row("SELECT count(*) FROM dead_letter", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1000, "dead_letter must cap at 1000 per source");
        // newest survive
        let newest: i64 = st
            .conn
            .query_row("SELECT count(*) FROM dead_letter WHERE fragment LIKE 'frag-1-%'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(newest, 600);
    }

    #[test]
    fn same_value_win_publishes_no_change() {
        let mut st = Store::open(":memory:").unwrap();
        reconcile(&mut st, &cfg("api", 10), outcome(vec![rec("api", "a@x.com", "name", "Ann", 100)]), 0, "h").unwrap();
        let s = reconcile(&mut st, &cfg("csv", 5), outcome(vec![rec("csv", "a@x.com", "name", "Ann", 150)]), 0, "h").unwrap();
        assert!(s.collections.is_empty());
    }
}
