//! engine_close must leave the WAL folded back into the main database.
//!
//! The close path runs `PRAGMA wal_checkpoint(TRUNCATE)` and discards the
//! result. TRUNCATE cannot complete while another connection holds the database
//! open, so once a second (read-only) connection existed, this could silently
//! stop working and leave a multi-megabyte WAL behind for the next open.
use reconcile_engine::ffi::*;
use std::ffi::{CStr, CString};
use std::os::raw::c_void;

const CFG: &str = r#"{"source_id":"api","format":"Json","collection":"people","natural_key_field":"id","timestamp_field":null,"priority":1}"#;

fn exec(h: *mut c_void, req: &str) -> String {
    let c = CString::new(req).unwrap();
    unsafe { let r = engine_execute(h, c.as_ptr());
        let s = CStr::from_ptr(r).to_str().unwrap().to_string(); engine_free_string(r); s }
}

#[test]
fn close_truncates_the_wal() {
    let dir = std::env::temp_dir().join(format!("reconcile-wal-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let db = dir.join("wal.sqlite");
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{suffix}", db.display()));
    }
    let path = CString::new(db.to_str().unwrap()).unwrap();

    let h = engine_open(path.as_ptr());
    exec(h, &format!(r#"{{"cmd":"registerSource","args":[{}]}}"#, serde_json::to_string(CFG).unwrap()));
    let mut rows = String::from("[");
    for i in 0..4000 {
        if i > 0 { rows.push(','); }
        rows.push_str(&format!(r#"{{"id":"{i}","note":"{}"}}"#, "x".repeat(300)));
    }
    rows.push(']');
    exec(h, &format!(r#"{{"cmd":"ingest","args":["api",{}]}}"#, serde_json::to_string(&rows).unwrap()));

    let wal = std::path::PathBuf::from(format!("{}-wal", db.display()));
    let before = std::fs::metadata(&wal).map(|m| m.len()).unwrap_or(0);
    engine_close(h);
    let after = std::fs::metadata(&wal).map(|m| m.len()).unwrap_or(0);

    eprintln!("wal before close: {before} bytes, after: {after} bytes");
    assert!(before > 0, "test needs a non-empty WAL to be meaningful");
    assert_eq!(after, 0, "close left {after} bytes of WAL — the TRUNCATE checkpoint did not run");

    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{suffix}", db.display()));
    }
}
