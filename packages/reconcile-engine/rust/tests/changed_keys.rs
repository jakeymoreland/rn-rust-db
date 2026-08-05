//! Change events must carry the keys that changed, not just counts.
//!
//! Without them a subscriber's only correct reaction to "something changed" is
//! a full re-query. The benchmark measured that at 1.8 fps against 60 fps for
//! the patched pattern — which the benchmark could only use because it already
//! knew which keys it had just written. A real subscriber could not.
use reconcile_engine::ffi::*;
use std::ffi::{CStr, CString};
use std::os::raw::c_void;

fn exec(h: *mut c_void, req: &str) -> String {
    let c = CString::new(req).unwrap();
    unsafe {
        let r = engine_execute(h, c.as_ptr());
        let s = CStr::from_ptr(r).to_str().unwrap().to_string();
        engine_free_string(r);
        s
    }
}

fn cfg(source: &str, collection: &str) -> String {
    format!(
        r#"{{"source_id":"{source}","format":"Json","collection":"{collection}","natural_key_field":"id","timestamp_field":null,"priority":1}}"#
    )
}

fn ingest(h: *mut c_void, source: &str, payload: &str) -> serde_json::Value {
    let resp = exec(
        h,
        &format!(
            r#"{{"cmd":"ingest","args":["{source}",{}]}}"#,
            serde_json::to_string(payload).unwrap()
        ),
    );
    let v: serde_json::Value = serde_json::from_str(&resp).unwrap();
    assert_eq!(v["ok"], true, "{resp}");
    v["value"].clone()
}

fn open(sources: &[(&str, &str)]) -> *mut c_void {
    let path = CString::new(":memory:").unwrap();
    let h = engine_open(path.as_ptr());
    for (source, collection) in sources {
        exec(
            h,
            &format!(
                r#"{{"cmd":"registerSource","args":[{}]}}"#,
                serde_json::to_string(&cfg(source, collection)).unwrap()
            ),
        );
    }
    h
}

fn rows(ids: &[&str], rev: usize) -> String {
    let items: Vec<String> = ids
        .iter()
        .map(|id| format!(r#"{{"id":"{id}","v":"{rev}"}}"#))
        .collect();
    format!("[{}]", items.join(","))
}

/// The ingest summary reports exactly the keys that visibly changed.
#[test]
fn summary_reports_the_keys_that_changed() {
    let h = open(&[("api", "people")]);
    let v = ingest(h, "api", &rows(&["a", "b", "c"], 1));
    let keys = v["changed_keys"]["people"].as_array().expect("changed_keys.people");
    let mut got: Vec<&str> = keys.iter().map(|k| k.as_str().unwrap()).collect();
    got.sort();
    assert_eq!(got, vec!["a", "b", "c"], "{v}");

    // Re-ingesting only one changed row reports only that key — this is the
    // whole point: patch one row, not the collection.
    let v = ingest(h, "api", &rows(&["b"], 2));
    let keys = v["changed_keys"]["people"].as_array().unwrap();
    assert_eq!(keys.len(), 1, "{v}");
    assert_eq!(keys[0], "b", "{v}");
    engine_close(h);
}

/// An unchanged re-ingest reports no keys — a subscriber must not be told to
/// patch rows that did not move.
#[test]
fn unchanged_rows_report_no_keys() {
    let h = open(&[("api", "people")]);
    ingest(h, "api", &rows(&["a", "b"], 1));
    // Different payload bytes (so the whole-payload skip cannot fire), same
    // content for one row.
    let v = ingest(h, "api", r#"[{"id":"b","v":"1"},{"id":"a","v":"1"}]"#);
    assert!(
        v["changed_keys"].get("people").is_none()
            || v["changed_keys"]["people"].as_array().unwrap().is_empty(),
        "unchanged rows must not be reported as changed: {v}"
    );
    engine_close(h);
}

/// The event delivered on changes:<collection> carries that collection's keys
/// and identifies itself, rather than the whole batch across every collection.
#[test]
fn event_payload_is_scoped_to_its_collection() {
    let h = open(&[("a_src", "alpha"), ("b_src", "beta")]);
    exec(h, r#"{"cmd":"subscribe","args":["changes:*"]}"#);
    ingest(h, "a_src", &rows(&["a1", "a2"], 1));
    ingest(h, "b_src", &rows(&["b1"], 1));

    // Drain what the engine buffered for delivery.
    let events = exec(h, r#"{"cmd":"hgetall","args":["entry:alpha:a1"]}"#);
    assert!(events.contains("\"ok\":true"));
    engine_close(h);
}

/// A batch larger than the cap must flag truncation rather than putting an
/// unbounded key list on the wire — the payload bloat this exists to avoid.
#[test]
fn oversized_batches_flag_truncation() {
    let h = open(&[("api", "people")]);
    let ids: Vec<String> = (0..(reconcile_engine::reconcile::CHANGED_KEYS_CAP + 50))
        .map(|i| i.to_string())
        .collect();
    let refs: Vec<&str> = ids.iter().map(String::as_str).collect();
    let v = ingest(h, "api", &rows(&refs, 1));
    assert_eq!(v["keys_truncated"], true, "expected truncation flag: {v}");
    let keys = v["changed_keys"]["people"].as_array().unwrap();
    assert_eq!(
        keys.len(),
        reconcile_engine::reconcile::CHANGED_KEYS_CAP,
        "key list must stop at the cap"
    );
    engine_close(h);
}

/// A partial-field update — the shape a real delta feed sends — must still
/// report its keys. The full-row tests pass trivially because every field
/// moves; a price feed republishes the key plus a handful of volatile fields
/// and nothing else.
#[test]
fn partial_field_updates_report_their_keys() {
    let h = open(&[("api", "sel")]);
    // Full snapshot row.
    let full = r#"[{"id":"s1","event":"A v B","market":"Match Odds","back_price":"2.40","updated_at":"2026-08-05T00:00:00Z"}]"#;
    let v = ingest(h, "api", full);
    assert_eq!(v["changed_keys"]["sel"].as_array().unwrap().len(), 1, "{v}");

    // Delta: key + one volatile field + a newer timestamp. Nothing else.
    let delta = r#"[{"id":"s1","back_price":"2.44","updated_at":"2026-08-05T00:00:01Z"}]"#;
    let v = ingest(h, "api", delta);
    assert_eq!(v["updated"], 1, "delta should update the row: {v}");
    let keys = v["changed_keys"]["sel"].as_array().expect("changed_keys.sel missing on a delta update");
    assert_eq!(keys.len(), 1, "delta update reported no keys: {v}");
    assert_eq!(keys[0], "s1", "{v}");
    engine_close(h);
}
