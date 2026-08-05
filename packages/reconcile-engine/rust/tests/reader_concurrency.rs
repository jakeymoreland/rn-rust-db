//! Reads must not queue behind an in-flight write.
//!
//! The engine held one SQLite `Connection` behind one mutex, so a query waited
//! for whatever ingest happened to be running. On a moto g35 that showed up as
//! 1.9 fps and a 2.1 s JS-thread stall with four sync readers alongside 10k-row
//! ingests, against 65 fps for the same load with no sync readers — the readers
//! were never slow, only blocked.
//!
//! WAL already allows one writer plus N concurrent readers; these tests pin the
//! read-only connection that finally uses it.

use reconcile_engine::ffi::*;
use std::ffi::{CStr, CString};
use std::os::raw::c_void;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

const WAVES: usize = 6;

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

/// `rows` records of roughly the shape the benchmark uses, so an ingest takes
/// long enough to still be running when the reader fires.
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

fn query_len(h: *mut c_void, collection: &str) -> usize {
    let col = CString::new(collection).unwrap();
    let mut len: usize = 0;
    let p = engine_query_entries_bin(h, col.as_ptr(), &mut len);
    assert!(!p.is_null(), "query returned null");
    engine_free_bytes(p, len);
    len
}

/// A file-backed engine gets a read-only connection, so a query issued while a
/// large ingest is in flight completes without waiting for it.
///
/// The assertion is deliberately loose (readers must finish in a fraction of the
/// write, not in some absolute time) so it stays meaningful on slow CI boxes
/// without turning into a flake.
#[test]
fn queries_do_not_block_behind_an_in_flight_ingest() {
    let dir = std::env::temp_dir().join(format!("reconcile-reader-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let db = dir.join("concurrency.sqlite");
    let _ = std::fs::remove_file(&db);
    let path = CString::new(db.to_str().unwrap()).unwrap();

    let h = engine_open(path.as_ptr());
    assert!(!h.is_null());
    exec(
        h,
        &format!(r#"{{"cmd":"registerSource","args":[{}]}}"#, serde_json::to_string(CFG).unwrap()),
    );

    // Seed so the reader has real work to do rather than scanning an empty table.
    ingest(h, &payload(2_000, "seed"));

    // Two uncontended baselines: how long a read takes with nobody writing, and
    // how long ONE ingest wave takes. A reader that still serialises behind the
    // writer shows a worst-case read of roughly a whole wave; a concurrent one
    // stays near the read baseline. Those differ by more than an order of
    // magnitude, which is what makes this test discriminating rather than a
    // wall-clock guess.
    let t = Instant::now();
    let baseline_len = query_len(h, "people");
    let read_baseline = t.elapsed();
    assert!(baseline_len > 0);

    let t = Instant::now();
    ingest(h, &payload(4_000, "warm"));
    let wave = t.elapsed();
    assert!(
        wave > read_baseline * 4,
        "an ingest wave ({wave:?}) must dominate a read ({read_baseline:?}) for this test to \
         distinguish blocked reads from concurrent ones"
    );

    // Now hammer the writer on another thread and read while it runs.
    let writing = Arc::new(AtomicBool::new(true));
    let handle_addr = h as usize;
    let writer = {
        let writing = Arc::clone(&writing);
        std::thread::spawn(move || {
            let h = handle_addr as *mut c_void;
            for w in 0..WAVES {
                ingest(h, &payload(4_000, &format!("wave{w}")));
            }
            writing.store(false, Ordering::SeqCst);
        })
    };

    let mut worst = Duration::ZERO;
    let mut reads = 0usize;
    while writing.load(Ordering::SeqCst) {
        let h = handle_addr as *mut c_void;
        let t = Instant::now();
        let len = query_len(h, "people");
        worst = worst.max(t.elapsed());
        assert!(len > 0, "reader saw an empty collection mid-write");
        reads += 1;
    }
    writer.join().unwrap();

    eprintln!(
        "reads={reads} worst={worst:?} uncontended-read={read_baseline:?} ingest-wave={wave:?}"
    );
    assert!(reads > 0, "writer finished before any concurrent read ran");
    // A blocked reader can only run in the gaps between ingest calls, so its
    // worst read is about one whole wave. Half a wave is comfortably below that
    // and comfortably above a genuinely concurrent read.
    assert!(
        worst < wave / 2,
        "worst concurrent read {worst:?} approaches a whole ingest wave ({wave:?}) \
         over {reads} reads (uncontended read: {read_baseline:?}) — reads are \
         queueing behind the writer again"
    );
    // A blocked reader also completes roughly one read per wave; a concurrent
    // one gets many. Guards the case where waves are fast enough to sneak under
    // the latency ceiling above.
    assert!(
        reads > WAVES * 3,
        "only {reads} reads completed across {WAVES} ingest waves — reads look \
         serialised with the writer rather than concurrent"
    );

    engine_close(h);
    let _ = std::fs::remove_file(&db);
}

/// `:memory:` has no second connection to open (a second one would be a
/// different, empty database), so it must fall back to the engine connection and
/// keep returning correct results rather than an empty buffer.
#[test]
fn memory_databases_fall_back_to_the_engine_connection() {
    let path = CString::new(":memory:").unwrap();
    let h = engine_open(path.as_ptr());
    assert!(!h.is_null());
    exec(
        h,
        &format!(r#"{{"cmd":"registerSource","args":[{}]}}"#, serde_json::to_string(CFG).unwrap()),
    );
    ingest(h, &payload(16, "mem"));
    assert!(query_len(h, "people") > 0, ":memory: read returned nothing");
    engine_close(h);
}
