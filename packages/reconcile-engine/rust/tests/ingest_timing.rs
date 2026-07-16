// Perf harness, not a correctness test: times update-wave ingests like the
// Industry bulk benchmark. Run with --release --nocapture; toggle parallelism
// via RECONCILE_PAR_THRESHOLD.
use std::ffi::{CStr, CString};
use std::os::raw::c_void;
use std::time::Instant;

use reconcile_engine::ffi::*;

fn exec(h: *mut c_void, req: &str) -> String {
    let c = CString::new(req).unwrap();
    unsafe {
        let r = engine_execute(h, c.as_ptr());
        let s = CStr::from_ptr(r).to_str().unwrap().to_string();
        engine_free_string(r);
        s
    }
}

fn rows(n: usize, rev: usize) -> String {
    let mut out = String::from("[");
    for i in 0..n {
        if i > 0 { out.push(','); }
        out.push_str(&format!(
            r#"{{"id":"rec_{i:07}","uuid":"u-{i}-{rev}","first_name":"Ann","last_name":"Chen","email":"a{i}@x.com","phone":"+61 4{rev:04}{i:04}","address_line1":"{i} George St","address_city":"Sydney","address_state":"NSW","address_postcode":"2000","billing_city":"Perth","billing_postcode":"6000","company":"Acme","job_title":"Analyst","status":"active","is_active":true,"email_verified":false,"balance":{rev}.5,"lifetime_value":{i}.25,"currency":"AUD","created_at":"2026-01-01T00:00:00Z","updated_at":"2026-07-17T00:00:0{rev}Z","notes":"{}"}}"#,
            "Follow-up scheduled after quarterly account review; premium reporting module interest. ".repeat(4),
        ));
    }
    out.push(']');
    out
}

#[test]
fn time_bulk_update_waves() {
    let path = CString::new(":memory:").unwrap();
    let h = engine_open(path.as_ptr());
    let reg = r#"{"cmd":"registerSource","args":["{\"source_id\":\"api\",\"format\":\"Json\",\"collection\":\"bench\",\"natural_key_field\":\"id\",\"timestamp_field\":\"updated_at\",\"priority\":10}"]}"#;
    assert!(exec(h, reg).contains("\"ok\":true"));

    let src = CString::new("api").unwrap();
    // seed
    let seed = CString::new(rows(1000, 0)).unwrap();
    let r = engine_ingest_direct(h, src.as_ptr(), seed.as_ptr());
    engine_free_string(r);

    for rev in 1..=5 {
        let payload = CString::new(rows(1000, rev)).unwrap();
        let t0 = Instant::now();
        let r = engine_ingest_direct(h, src.as_ptr(), payload.as_ptr());
        let ms = t0.elapsed().as_secs_f64() * 1000.0;
        let resp = unsafe { CStr::from_ptr(r) }.to_str().unwrap().to_string();
        engine_free_string(r);
        assert!(resp.contains("\"ok\":true"), "{resp}");
        println!("wave {rev}: {ms:.1} ms  ({resp:.80})");
    }
    engine_close(h);
}
