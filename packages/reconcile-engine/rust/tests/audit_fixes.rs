// Regression tests for the 2026-07-19 audit fixes (findings C1, C2, S1 —
// docs/superpowers/audits/2026-07-19-engine-audit-findings.md). Task-by-task
// tests accumulate here as the fix plan executes.
use reconcile_engine::dispatch::execute;
use reconcile_engine::engine::Engine;

fn eng() -> Engine {
    Engine::open(":memory:", Box::new(|| 5_000_000)).unwrap()
}

/// Engine whose clock advances 1 ms per call — matches real devices, where the
/// C1 bug makes later ingests win regardless of their declared timestamps.
fn eng_ticking() -> Engine {
    use std::sync::atomic::{AtomicI64, Ordering};
    let t = AtomicI64::new(5_000_000);
    Engine::open(":memory:", Box::new(move || t.fetch_add(1, Ordering::Relaxed))).unwrap()
}

fn ok_value(resp: &str) -> serde_json::Value {
    let v: serde_json::Value = serde_json::from_str(resp).unwrap();
    assert_eq!(v["ok"], true, "expected ok response, got {resp}");
    v["value"].clone()
}

fn register(e: &mut Engine, cfg_json: &str) {
    ok_value(&execute(
        e,
        &format!(
            r#"{{"cmd":"registerSource","args":[{}]}}"#,
            serde_json::to_string(cfg_json).unwrap()
        ),
    ));
}

fn ingest(e: &mut Engine, source: &str, payload: &str) -> serde_json::Value {
    ok_value(&execute(
        e,
        &format!(
            r#"{{"cmd":"ingest","args":["{source}",{}]}}"#,
            serde_json::to_string(payload).unwrap()
        ),
    ))
}

fn hgetall(e: &mut Engine, key: &str) -> serde_json::Value {
    ok_value(&execute(e, &format!(r#"{{"cmd":"hgetall","args":["{key}"]}}"#)))
}

const ISO_CFG: &str = r#"{"source_id":"api","format":"Json","collection":"people","natural_key_field":"email","timestamp_field":"updated_at","priority":10}"#;

// C1: ISO-8601 timestamps must drive LWW ordering; before the fix both batches
// silently fall back to ingest-time now_ms and the stale batch wins.
#[test]
fn iso8601_timestamps_drive_lww_ordering() {
    let mut e = eng_ticking();
    register(&mut e, ISO_CFG);
    let fresh = r#"[{"email":"a@x.com","name":"new","updated_at":"2026-07-17T00:00:10Z"}]"#;
    let stale = r#"[{"email":"a@x.com","name":"old","updated_at":"2026-07-17T00:00:01Z"}]"#;
    let s1 = ingest(&mut e, "api", fresh);
    assert_eq!(s1["inserted"], 1);
    let s2 = ingest(&mut e, "api", stale);
    assert_eq!(s2["updated"], 0, "stale batch must not update: {s2}");
    assert_eq!(s2["unchanged"], 1, "{s2}");
    let row = hgetall(&mut e, "entry:people:a@x.com");
    assert_eq!(row["name"], "new", "stale ISO batch overwrote fresh data");
}

// C1: a configured-but-unparseable timestamp is data corruption waiting to
// happen; it must dead-letter, not silently take ingest time.
#[test]
fn unparseable_timestamp_dead_letters_instead_of_now_fallback() {
    let mut e = eng();
    register(&mut e, ISO_CFG);
    let s = ingest(
        &mut e,
        "api",
        r#"[{"email":"a@x.com","name":"A","updated_at":"not-a-date"}]"#,
    );
    assert_eq!(s["inserted"], 0, "{s}");
    assert_eq!(s["dead_lettered"], 1, "{s}");
    let n = ok_value(&execute(&mut e, r#"{"cmd":"deadLetterCount","args":[]}"#));
    assert_eq!(n, 1);
    let row = hgetall(&mut e, "entry:people:a@x.com");
    assert!(row.as_object().map(|o| o.is_empty()).unwrap_or(true), "{row}");
}

// C2: JSON null natural keys must dead-letter, not merge into one "null" row.
#[test]
fn null_natural_key_dead_letters() {
    let mut e = eng();
    register(&mut e, ISO_CFG);
    let s = ingest(
        &mut e,
        "api",
        r#"[{"email":null,"name":"A"},{"email":null,"name":"B"}]"#,
    );
    assert_eq!(s["inserted"], 0, "{s}");
    assert_eq!(s["dead_lettered"], 2, "{s}");
    let row = hgetall(&mut e, "entry:people:null");
    assert!(row.as_object().map(|o| o.is_empty()).unwrap_or(true), "null-key row exists: {row}");
}

// C2 coercion rules: integer keys keep colliding with their string form (documented),
// but float keys dead-letter instead of minting a distinct "1.0" row.
#[test]
fn float_natural_key_dead_letters() {
    let mut e = eng();
    let cfg = r#"{"source_id":"api","format":"Json","collection":"nums","natural_key_field":"id","timestamp_field":null,"priority":10}"#;
    register(&mut e, cfg);
    let s = ingest(&mut e, "api", r#"[{"id":1,"v":"int"},{"id":1.0,"v":"float"}]"#);
    assert_eq!(s["dead_lettered"], 1, "{s}");
    assert_eq!(s["inserted"], 1, "{s}");
    let row = hgetall(&mut e, "entry:nums:1");
    assert_eq!(row["v"], "int");
    let bad = hgetall(&mut e, "entry:nums:1.0");
    assert!(bad.as_object().map(|o| o.is_empty()).unwrap_or(true), "{bad}");
}

// S15: re-registering a source with a changed config must NOT let a
// byte-identical payload hit the skip — the data has to reconcile under the
// new rules (here, a changed priority).
#[test]
fn changed_source_config_defeats_payload_skip() {
    let mut e = eng();
    let cfg_a = r#"{"source_id":"api","format":"Json","collection":"people","natural_key_field":"email","timestamp_field":null,"priority":10}"#;
    register(&mut e, cfg_a);
    let payload = r#"[{"email":"a@x.com","name":"Ann"}]"#;
    let s1 = ingest(&mut e, "api", payload);
    assert_eq!(s1["inserted"], 1);
    // Same payload again -> skipped.
    let s2 = ingest(&mut e, "api", payload);
    assert_eq!(s2["skipped"], true, "{s2}");
    // Re-register with a different priority, then re-ingest identical bytes.
    let cfg_b = r#"{"source_id":"api","format":"Json","collection":"people","natural_key_field":"email","timestamp_field":null,"priority":25}"#;
    register(&mut e, cfg_b);
    let s3 = ingest(&mut e, "api", payload);
    assert_eq!(s3["skipped"], false, "config change must defeat the skip: {s3}");
}

// S1: numerically equal values from different formats must converge instead of
// flip-flopping (JSON 1000.0 vs "1000").
#[test]
fn numeric_values_canonicalize_across_formats() {
    let mut e = eng();
    let cfg = r#"{"source_id":"api","format":"Json","collection":"acct","natural_key_field":"id","timestamp_field":null,"priority":10}"#;
    register(&mut e, cfg);
    let s1 = ingest(&mut e, "api", r#"[{"id":"k1","balance":1000.0}]"#);
    assert_eq!(s1["inserted"], 1);
    let row = hgetall(&mut e, "entry:acct:k1");
    assert_eq!(row["balance"], "1000", "float 1000.0 must canonicalize: {row}");
    // Same numeric value as a string from a "different" payload (hash differs
    // because of an extra field) must be unchanged, not an update.
    let s2 = ingest(&mut e, "api", r#"[{"id":"k1","balance":"1000","note":"x"}]"#);
    assert_eq!(s2["updated"], 1, "note field is new: {s2}"); // row updates for note
    let s3 = ingest(&mut e, "api", r#"[{"id":"k1","balance":1000.0,"note":"x"}]"#);
    assert_eq!(s3["unchanged"], 1, "equal numerics flip-flopped: {s3}");
    assert_eq!(s3["updated"], 0, "{s3}");
}
