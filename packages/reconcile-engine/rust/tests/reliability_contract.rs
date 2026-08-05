//! The reliability contract the benchmark asserts, pinned in CI so it can never
//! regress silently. "Wrong shape must be rejected" is non-negotiable.
use reconcile_engine::ffi::*;
use std::ffi::{CStr, CString};
use std::os::raw::c_void;

const CFG: &str = r#"{"source_id":"rel","format":"Json","collection":"rel","natural_key_field":"id","timestamp_field":null,"priority":1}"#;
const WRONG_SHAPE: &str = r#"[{"wrong":"shape","no_id":true}]"#;

fn exec(h: *mut c_void, req: &str) -> String {
    let c = CString::new(req).unwrap();
    unsafe {
        let r = engine_execute(h, c.as_ptr());
        let s = CStr::from_ptr(r).to_str().unwrap().to_string();
        engine_free_string(r);
        s
    }
}

fn ingest(h: *mut c_void, payload: &str) -> serde_json::Value {
    let resp = exec(
        h,
        &format!(r#"{{"cmd":"ingest","args":["rel",{}]}}"#, serde_json::to_string(payload).unwrap()),
    );
    serde_json::from_str(&resp).unwrap()
}

fn open() -> *mut c_void {
    let path = CString::new(":memory:").unwrap();
    let h = engine_open(path.as_ptr());
    exec(h, &format!(r#"{{"cmd":"registerSource","args":[{}]}}"#, serde_json::to_string(CFG).unwrap()));
    h
}

/// A record missing the configured natural key must dead-letter, never land.
#[test]
fn wrong_shape_is_dead_lettered() {
    let h = open();
    let v = ingest(h, WRONG_SHAPE);
    assert_eq!(v["ok"], true, "{v}");
    assert_eq!(v["value"]["dead_lettered"], 1, "wrong shape was ACCEPTED: {v}");
    assert_eq!(v["value"]["inserted"], 0, "{v}");
    engine_close(h);
}

/// Malformed JSON must be a parse error, not a silent success.
#[test]
fn malformed_json_is_rejected() {
    let h = open();
    let v = ingest(h, "this is not json");
    assert_eq!(v["ok"], false, "malformed JSON was ACCEPTED: {v}");
    engine_close(h);
}

/// The whole-payload hash short-circuit is the ONE way a bad payload can come
/// back with dead_lettered: 0 — re-sending a byte-identical payload skips the
/// batch wholesale, so the second response reports no dead letters even though
/// the record is still (correctly) absent.
///
/// This is why a benchmark that asserts `dead_lettered > 0` must run against a
/// freshly wiped database: against a dirty one it reads a skip as an ACCEPT.
#[test]
fn repeated_bad_payload_is_skipped_not_reaccepted() {
    let h = open();
    let first = ingest(h, WRONG_SHAPE);
    assert_eq!(first["value"]["dead_lettered"], 1, "{first}");

    let second = ingest(h, WRONG_SHAPE);
    assert_eq!(second["ok"], true, "{second}");
    assert_eq!(
        second["value"]["dead_lettered"], 0,
        "expected the whole-payload skip to report no new dead letters: {second}"
    );
    assert_eq!(second["value"]["skipped"], true, "the skip flag is how a caller tells the two apart: {second}");
    // The important part: nothing was ever stored, either time.
    assert_eq!(second["value"]["inserted"], 0, "{second}");
    engine_close(h);
}
