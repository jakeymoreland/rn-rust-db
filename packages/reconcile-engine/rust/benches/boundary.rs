//! Caller-thread occupancy versus engine time for a bulk ingest.
//!
//! The device figure of ~388 ms is the longest stretch a 16 ms JS timer failed
//! to run while `ingest()` copied an entire ~95 MB string onto the JS thread.
//! This process has no Hermes runtime, so it measures the same split on the
//! host: how long the caller is blocked before it can return, and how long the
//! engine then spends inside `engine_ingest_bytes`.
//!
//! `BENCH_ROWS` overrides the row count (default 100_000).
use std::ffi::CString;
use std::hint::black_box;
use std::time::Instant;

use reconcile_engine::ffi::{engine_free_string, engine_ingest_bytes, engine_open};

const CHUNK: usize = 256 * 1024;

fn rows(n: usize) -> String {
    let mut out = String::from("[");
    for i in 0..n {
        if i > 0 {
            out.push(',');
        }
        // ~400 B/row keeps a 100k payload large enough that a full copy and a
        // 256 KB slice are distinguishable, without the 95 MB device shape.
        out.push_str(&format!(
            r#"{{"id":"k{i:07}","name":"Ann","city":"Sydney","status":"active","note":"{}","updated_at":1700000000000}}"#,
            "x".repeat(320)
        ));
    }
    out.push(']');
    out
}

fn max_chunk_copy_ms(payload: &[u8]) -> f64 {
    let mut max = 0.0f64;
    for chunk in payload.chunks(CHUNK) {
        let t = Instant::now();
        let mut buf = Vec::with_capacity(chunk.len());
        buf.extend_from_slice(chunk);
        black_box(&buf);
        max = max.max(t.elapsed().as_secs_f64() * 1000.0);
    }
    max
}

fn full_copy_ms(payload: &[u8]) -> f64 {
    let t = Instant::now();
    let mut buf = Vec::with_capacity(payload.len());
    buf.extend_from_slice(payload);
    black_box(&buf);
    t.elapsed().as_secs_f64() * 1000.0
}

fn main() {
    let n: usize = std::env::var("BENCH_ROWS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(100_000);
    let payload = rows(n);
    let bytes = payload.as_bytes();
    let copy_ms = full_copy_ms(bytes);
    let chunk_ms = max_chunk_copy_ms(bytes);

    let path = CString::new(":memory:").unwrap();
    let handle = engine_open(path.as_ptr());
    assert!(!handle.is_null(), "engine_open failed");
    let reg = CString::new(
        r#"{"cmd":"registerSource","args":["{\"source_id\":\"api\",\"format\":\"Json\",\"collection\":\"bench\",\"natural_key_field\":\"id\",\"timestamp_field\":\"updated_at\",\"priority\":10}"]}"#,
    )
    .unwrap();
    let r = reconcile_engine::ffi::engine_execute(handle, reg.as_ptr());
    engine_free_string(r);
    let src = CString::new("api").unwrap();
    let t = Instant::now();
    let resp = engine_ingest_bytes(handle, src.as_ptr(), bytes.as_ptr(), bytes.len());
    let engine_ms = t.elapsed().as_secs_f64() * 1000.0;
    let text = unsafe { std::ffi::CStr::from_ptr(resp) }.to_string_lossy().to_string();
    engine_free_string(resp);
    reconcile_engine::ffi::engine_close(handle);
    if !text.contains("\"ok\":true") {
        eprintln!("ingest failed: {text}");
        std::process::exit(1);
    }
    let timings = text
        .find("\"timings\"")
        .map(|i| {
            let rest = &text[i..];
            rest.split("},").next().unwrap_or(rest).to_string()
        })
        .unwrap_or_else(|| "(no timings)".into());

    println!();
    println!("| path | caller-thread max gap | engine time |");
    println!("|---|---:|---:|");
    println!(
        "| sync ingest (engine_ingest_bytes on the caller) | {engine_ms:.1} ms | included |"
    );
    println!("| full-buffer copy (argument marshal only) | {copy_ms:.2} ms | — |");
    println!("| chunked 256 KB (max slice copy) | {chunk_ms:.3} ms | {engine_ms:.1} ms |");
    println!();
    println!(
        "rows {n}, payload {:.1} MB, {timings}",
        bytes.len() as f64 / 1_000_000.0
    );
}
