//! Tombstones, snapshot omission, compaction, and the hybrid clock.
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;

use reconcile_engine::clock::DEFAULT_SKEW_BOUND_MS;
use reconcile_engine::commands::{self, compact_tombstones};
use reconcile_engine::dispatch::execute;
use reconcile_engine::engine::Engine;
use reconcile_engine::normalize::{CanonicalRecord, NormalizeOutcome, SourceConfig, SourceFormat};
use reconcile_engine::reconcile::reconcile;
use reconcile_engine::store::Store;

fn cfg(source: &str, priority: u32) -> SourceConfig {
    SourceConfig {
        source_id: source.into(),
        format: SourceFormat::Json,
        collection: "people".into(),
        natural_key_field: "id".into(),
        timestamp_field: Some("updated_at".into()),
        priority,
        snapshot: false,
    }
}

fn rec(source: &str, key: &str, value: &str, ts: i64, deleted: bool) -> CanonicalRecord {
    let mut fields = std::collections::BTreeMap::new();
    fields.insert("id".into(), key.into());
    if !deleted {
        fields.insert("name".into(), value.into());
    }
    CanonicalRecord {
        collection: "people".into(),
        natural_key: key.into(),
        source: source.into(),
        fields,
        updated_at: ts,
        logical: 0,
        timestamped: true,
        deleted,
    }
}

fn apply(st: &mut Store, records: Vec<CanonicalRecord>, source: &str, pri: u32) {
    let outcome = NormalizeOutcome { records, rejects: vec![] };
    reconcile(st, &cfg(source, pri), outcome, 0, "h").unwrap();
}

fn name_of(st: &Store, key: &str) -> Option<String> {
    let h = commands::hgetall(st, &format!("entry:people:{key}"), 0).unwrap();
    h.get("name").cloned()
}

#[test]
fn delete_then_older_update_stays_hidden_and_a_newer_update_resurrects() {
    let mut st = Store::open(":memory:").unwrap();
    apply(&mut st, vec![rec("api", "a", "Ann", 100, false)], "api", 10);
    apply(&mut st, vec![rec("api", "a", "", 150, true)], "api", 10);
    assert!(name_of(&st, "a").is_none(), "tombstone should hide the row");
    apply(&mut st, vec![rec("feed", "a", "Stale", 120, false)], "feed", 10);
    assert!(name_of(&st, "a").is_none(), "older update must not resurrect");
    apply(&mut st, vec![rec("feed", "a", "Back", 180, false)], "feed", 10);
    assert_eq!(name_of(&st, "a").as_deref(), Some("Back"));
}

#[test]
fn delete_and_update_converge_regardless_of_order() {
    let forward = {
        let mut st = Store::open(":memory:").unwrap();
        apply(&mut st, vec![rec("api", "a", "Ann", 100, false)], "api", 10);
        apply(&mut st, vec![rec("api", "a", "", 200, true)], "api", 10);
        name_of(&st, "a")
    };
    let backward = {
        let mut st = Store::open(":memory:").unwrap();
        apply(&mut st, vec![rec("api", "a", "", 200, true)], "api", 10);
        apply(&mut st, vec![rec("api", "a", "Ann", 100, false)], "api", 10);
        name_of(&st, "a")
    };
    assert_eq!(forward, backward);
    assert!(forward.is_none());
}

#[test]
fn equal_version_delete_beats_update() {
    let mut left = Store::open(":memory:").unwrap();
    apply(&mut left, vec![rec("api", "a", "Ann", 100, false)], "api", 10);
    apply(&mut left, vec![rec("api", "a", "", 100, true)], "api", 10);
    let mut right = Store::open(":memory:").unwrap();
    apply(&mut right, vec![rec("api", "a", "", 100, true)], "api", 10);
    apply(&mut right, vec![rec("api", "a", "Ann", 100, false)], "api", 10);
    assert!(name_of(&left, "a").is_none());
    assert!(name_of(&right, "a").is_none());
}

#[test]
fn snapshot_omission_tombstones_the_missing_key() {
    let mut st = Store::open(":memory:").unwrap();
    let mut snap = cfg("feed", 10);
    snap.snapshot = true;
    let ingest = |st: &mut Store, keys: &[(&str, i64)]| {
        let records = keys
            .iter()
            .map(|(k, ts)| rec("feed", k, "live", *ts, false))
            .collect();
        reconcile(st, &snap, NormalizeOutcome { records, rejects: vec![] }, 0, "snap").unwrap();
    };
    ingest(&mut st, &[("a", 100), ("b", 100)]);
    assert!(name_of(&st, "a").is_some());
    ingest(&mut st, &[("a", 200)]);
    assert!(name_of(&st, "a").is_some());
    assert!(name_of(&st, "b").is_none(), "b stopped arriving and must leave the book");
}

#[test]
fn compaction_drops_only_tombstones_older_than_the_horizon() {
    let mut st = Store::open(":memory:").unwrap();
    apply(&mut st, vec![rec("api", "old", "", 1_000, true)], "api", 10);
    apply(&mut st, vec![rec("api", "new", "", 50_000, true)], "api", 10);
    let now = 1_000 + clock_ttl() + 1;
    let n = compact_tombstones(&st, now, None).unwrap();
    assert!(n >= 1);
    // The compacted tombstone is gone, so an older update is a fresh insert.
    apply(&mut st, vec![rec("api", "old", "resurrected", 500, false)], "api", 10);
    assert_eq!(name_of(&st, "old").as_deref(), Some("resurrected"));
    // The younger tombstone is still there and still beats an older update.
    apply(&mut st, vec![rec("api", "new", "nope", 1_000, false)], "api", 10);
    assert!(name_of(&st, "new").is_none());
}

fn clock_ttl() -> i64 {
    reconcile_engine::clock::DEFAULT_TOMBSTONE_TTL_MS
}

#[test]
fn json_deleted_flag_hides_the_row() {
    let mut e = Engine::open(":memory:", Box::new(|| 0)).unwrap();
    let reg = r#"{"cmd":"registerSource","args":["{\"source_id\":\"api\",\"format\":\"Json\",\"collection\":\"people\",\"natural_key_field\":\"email\",\"timestamp_field\":\"updated_at\",\"priority\":10}"]}"#;
    assert!(execute(&mut e, reg).contains("\"ok\":true"));
    e.ingest("api", r#"[{"email":"a@x.com","name":"Ann","updated_at":100}]"#).unwrap();
    let (summary, _) = e
        .ingest("api", r#"[{"email":"a@x.com","_deleted":true,"updated_at":200}]"#)
        .unwrap();
    assert_eq!(summary.deleted, 1);
    let h = commands::hgetall(&e.store, "entry:people:a@x.com", 0).unwrap();
    assert!(h.is_empty());
    let keys = commands::scan(&mut e, "entry:people:*", 0).unwrap();
    assert!(keys.is_empty(), "scan must not resurface a tombstone: {keys:?}");
}

#[test]
fn untimestamped_ingest_survives_a_backward_wall_clock() {
    let now = Arc::new(AtomicI64::new(5_000));
    let clock = Arc::clone(&now);
    let mut e = Engine::open(":memory:", Box::new(move || clock.load(Ordering::SeqCst))).unwrap();
    let reg = r#"{"cmd":"registerSource","args":["{\"source_id\":\"api\",\"format\":\"Json\",\"collection\":\"people\",\"natural_key_field\":\"id\",\"timestamp_field\":null,\"priority\":10}"]}"#;
    assert!(execute(&mut e, reg).contains("\"ok\":true"));
    e.ingest("api", r#"[{"id":"1","name":"A"}]"#).unwrap();
    now.store(100, Ordering::SeqCst);
    e.ingest("api", r#"[{"id":"1","name":"B"}]"#).unwrap();
    let h = commands::hgetall(&e.store, "entry:people:1", 0).unwrap();
    assert_eq!(h.get("name").map(String::as_str), Some("B"));
    assert_eq!(h.get("_updated_at").map(String::as_str), Some("5000"));
}

#[test]
fn source_clock_ahead_of_skew_is_clamped() {
    let wall = 1_700_000_000_000i64;
    let mut e = Engine::open(":memory:", Box::new(move || wall)).unwrap();
    let reg = r#"{"cmd":"registerSource","args":["{\"source_id\":\"api\",\"format\":\"Json\",\"collection\":\"people\",\"natural_key_field\":\"id\",\"timestamp_field\":\"updated_at\",\"priority\":10}"]}"#;
    assert!(execute(&mut e, reg).contains("\"ok\":true"));
    let ahead = wall + 10 * 24 * 60 * 60 * 1000;
    let (summary, _) = e
        .ingest("api", &format!(r#"[{{"id":"1","name":"Future","updated_at":{ahead}}}]"#))
        .unwrap();
    assert_eq!(summary.clock_clamped, 1);
    let h = commands::hgetall(&e.store, "entry:people:1", 0).unwrap();
    assert_eq!(
        h.get("_updated_at").map(String::as_str),
        Some((wall + DEFAULT_SKEW_BOUND_MS).to_string()).as_deref()
    );
}
