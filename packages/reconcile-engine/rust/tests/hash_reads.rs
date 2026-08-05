//! `hget`/`hgetall`/`hmgetall` are pure store reads and must not queue behind
//! an in-flight ingest, and the batch form must agree exactly with N single
//! calls.
//!
//! Motivation: on both iOS and Android, `hgetall x100` measured ~5 s under
//! write load — 100 sequential JSI crossings, each taking the engine mutex,
//! each able to wait a whole batch. It consumed the entire 5 s measurement
//! window on its own.

use reconcile_engine::ffi::*;
use std::ffi::{CStr, CString};
use std::os::raw::c_void;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

const CFG: &str = r#"{"source_id":"api","format":"Json","collection":"people","natural_key_field":"id","timestamp_field":null,"priority":1}"#;

fn exec(h: *mut c_void, req: &str) -> String {
    let c = CString::new(req).unwrap();
    unsafe {
        let r = engine_execute(h, c.as_ptr());
        assert!(!r.is_null());
        let s = CStr::from_ptr(r).to_str().unwrap().to_string();
        engine_free_string(r);
        s
    }
}

fn ingest(h: *mut c_void, payload: &str) -> String {
    exec(
        h,
        &format!(
            r#"{{"cmd":"ingest","args":["api",{}]}}"#,
            serde_json::to_string(payload).unwrap()
        ),
    )
}

fn payload(rows: usize, tag: &str) -> String {
    let mut s = String::from("[");
    for i in 0..rows {
        if i > 0 {
            s.push(',');
        }
        s.push_str(&format!(
            r#"{{"id":"{i}","name":"{tag}-{i}","city":"Sydney","note":"{}"}}"#,
            "x".repeat(200)
        ));
    }
    s.push(']');
    s
}

fn temp_db(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("reconcile-hash-{}-{name}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let db = dir.join("db.sqlite");
    let _ = std::fs::remove_file(&db);
    db
}

/// The batch form must be indistinguishable from N single calls — including
/// misses, which come back as empty maps so the caller can zip positionally.
#[test]
fn hmgetall_matches_sequential_hgetall() {
    let db = temp_db("batch");
    let path = CString::new(db.to_str().unwrap()).unwrap();
    let h = engine_open(path.as_ptr());
    exec(h, &format!(r#"{{"cmd":"registerSource","args":[{}]}}"#, serde_json::to_string(CFG).unwrap()));
    ingest(h, &payload(50, "seed"));

    let keys: Vec<String> = (0..50)
        .map(|i| format!("entry:people:{i}"))
        .chain(["entry:people:nope".to_string(), "entry:missing:1".to_string()])
        .collect();

    let singles: Vec<serde_json::Value> = keys
        .iter()
        .map(|k| {
            let r = exec(h, &format!(r#"{{"cmd":"hgetall","args":[{}]}}"#, serde_json::to_string(k).unwrap()));
            let v: serde_json::Value = serde_json::from_str(&r).unwrap();
            assert_eq!(v["ok"], true, "{r}");
            v["value"].clone()
        })
        .collect();

    let batch_resp = exec(
        h,
        &format!(r#"{{"cmd":"hmgetall","args":{}}}"#, serde_json::to_string(&keys).unwrap()),
    );
    let batch: serde_json::Value = serde_json::from_str(&batch_resp).unwrap();
    assert_eq!(batch["ok"], true, "{batch_resp}");
    let batch = batch["value"].as_array().expect("array of maps");

    assert_eq!(batch.len(), keys.len(), "one result per key, in order");
    for (i, key) in keys.iter().enumerate() {
        assert_eq!(batch[i], singles[i], "batch disagreed with single hgetall for {key}");
    }
    // Sanity: the seeded rows are non-empty and the misses are empty.
    assert!(batch[0].as_object().unwrap().contains_key("name"));
    assert!(batch[50].as_object().unwrap().is_empty(), "miss must be an empty map");

    engine_close(h);
    let _ = std::fs::remove_file(&db);
}

/// hgetall must run on the read-only connection, so it completes while an
/// ingest holds the engine mutex rather than waiting a whole batch.
#[test]
fn hgetall_does_not_block_behind_an_in_flight_ingest() {
    let db = temp_db("concurrent");
    let path = CString::new(db.to_str().unwrap()).unwrap();
    let h = engine_open(path.as_ptr());
    exec(h, &format!(r#"{{"cmd":"registerSource","args":[{}]}}"#, serde_json::to_string(CFG).unwrap()));
    ingest(h, &payload(2_000, "seed"));

    let key = r#"{"cmd":"hgetall","args":["entry:people:1"]}"#;
    let t = Instant::now();
    exec(h, key);
    let read_baseline = t.elapsed();

    let t = Instant::now();
    ingest(h, &payload(4_000, "warm"));
    let wave = t.elapsed();
    assert!(wave > read_baseline * 4, "wave {wave:?} must dominate a read {read_baseline:?}");

    let writing = Arc::new(AtomicBool::new(true));
    let addr = h as usize;
    let writer = {
        let writing = Arc::clone(&writing);
        std::thread::spawn(move || {
            let h = addr as *mut c_void;
            for w in 0..6 {
                ingest(h, &payload(4_000, &format!("wave{w}")));
            }
            writing.store(false, Ordering::SeqCst);
        })
    };

    let mut worst = Duration::ZERO;
    let mut reads = 0usize;
    while writing.load(Ordering::SeqCst) {
        let h = addr as *mut c_void;
        let t = Instant::now();
        let r = exec(h, key);
        worst = worst.max(t.elapsed());
        assert!(r.contains("\"ok\":true"), "{r}");
        reads += 1;
    }
    writer.join().unwrap();

    eprintln!("hgetall reads={reads} worst={worst:?} uncontended={read_baseline:?} wave={wave:?}");
    assert!(
        worst < wave / 2,
        "worst concurrent hgetall {worst:?} approaches a whole ingest wave ({wave:?}) over \
         {reads} reads — hgetall is still taking the engine mutex"
    );

    engine_close(h);
    let _ = std::fs::remove_file(&db);
}
