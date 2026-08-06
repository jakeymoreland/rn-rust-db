//! What does a single insert actually cost, and is it durable?
//!
//! Context: a public claim of "0.32 ms single insert vs a 5–16 ms band for
//! offline-first JS databases" drew the reply that memory-first is not
//! persistence and that fsync cannot be avoided. Half of that is a misread —
//! this path is not the memory-first kv cache, it is parse → normalize →
//! content-hash → field-level reconcile → SQLite transaction commit. The other
//! half lands: the engine runs `synchronous = NORMAL`, so commits do NOT fsync,
//! and a single insert is durable against an app crash but not against power
//! loss.
//!
//! So measure both instead of arguing. Run with --nocapture.
use reconcile_engine::ffi::*;
use std::ffi::{CStr, CString};
use std::os::raw::c_void;
use std::time::Instant;

const CFG: &str = r#"{"source_id":"api","format":"Json","collection":"msg","natural_key_field":"id","timestamp_field":null,"priority":1}"#;

fn exec(h: *mut c_void, req: &str) -> String {
    let c = CString::new(req).unwrap();
    unsafe { let r = engine_execute(h, c.as_ptr());
        let s = CStr::from_ptr(r).to_str().unwrap().to_string(); engine_free_string(r); s }
}

/// One "message" of roughly the shape an offline-first DB comparison inserts.
fn row(i: usize) -> String {
    format!(
        r#"[{{"id":"m{i}","sender":"user{i}","body":"{}","sent_at":"2026-08-06T00:00:00Z","read":false}}]"#,
        "hello there, this is a chat message body ".repeat(3)
    )
}

fn median(mut xs: Vec<f64>) -> f64 {
    xs.sort_by(|a, b| a.partial_cmp(b).unwrap());
    xs[xs.len() / 2]
}

fn measure(label: &str, sync_mode: &str, fullfsync: bool) -> f64 {
    // SAFETY: single-threaded test; set before the engine opens its connection.
    unsafe {
        std::env::set_var("RECONCILE_SYNCHRONOUS", sync_mode);
        if fullfsync {
            std::env::set_var("RECONCILE_FULLFSYNC", "1");
        } else {
            std::env::remove_var("RECONCILE_FULLFSYNC");
        }
    }

    let dir = std::env::temp_dir().join(format!("reconcile-dur-{}-{sync_mode}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let db = dir.join("d.sqlite");
    for s in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{s}", db.display()));
    }
    let path = CString::new(db.to_str().unwrap()).unwrap();
    let h = engine_open(path.as_ptr());
    exec(h, &format!(r#"{{"cmd":"registerSource","args":[{}]}}"#, serde_json::to_string(CFG).unwrap()));

    let src = CString::new("api").unwrap();
    let mut times = Vec::new();
    for i in 0..60 {
        let p = CString::new(row(i)).unwrap();
        let t = Instant::now();
        let r = engine_ingest_direct(h, src.as_ptr(), p.as_ptr());
        let ms = t.elapsed().as_secs_f64() * 1000.0;
        let resp = unsafe { CStr::from_ptr(r) }.to_str().unwrap().to_string();
        engine_free_string(r);
        assert!(resp.contains("\"inserted\":1"), "{resp}");
        if i >= 10 { times.push(ms); } // discard warmup
    }
    engine_close(h);
    for s in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{s}", db.display()));
    }
    let m = median(times);
    println!("{label:<48} {m:.4} ms/insert");
    m
}

#[test]
fn single_insert_cost_with_and_without_fsync() {
    println!();
    println!("single-row insert: full pipeline (parse -> normalize -> hash -> reconcile -> commit)");
    println!("{}", "-".repeat(78));
    let off = measure("OFF        — no durability guarantee", "OFF", false);
    let normal = measure("NORMAL     — app-crash durable (engine default)", "NORMAL", false);
    let full = measure("FULL       — fsync() every commit", "FULL", false);
    let barrier = measure("FULL+full  — F_FULLFSYNC every commit (true barrier)", "FULL", true);
    println!("{}", "-".repeat(78));
    println!("fsync tax     {:.2}x   (FULL / NORMAL)", full / normal);
    println!("barrier tax   {:.2}x   (FULL+fullfsync / NORMAL)", barrier / normal);
    println!();
    println!("Host-machine numbers. Apple device storage behaves differently under");
    println!("F_FULLFSYNC than a Mac SSD does — the figure that belongs in a public");
    println!("claim is the on-device one.");
    // Not asserting a threshold: this is a measurement harness, not a gate.
    assert!(normal > 0.0 && full > 0.0 && off > 0.0 && barrier > 0.0);
}
