use reconcile_engine::ffi::*;
use std::ffi::{CStr, CString};

const FIELDS_CSV: &str = "id,uuid,first_name,last_name,email,phone,address_line1,address_city,address_state,address_postcode,billing_city,billing_postcode,company,job_title,status,is_active,email_verified,balance,lifetime_value,currency,created_at,updated_at,notes";

fn exec(h: *mut std::os::raw::c_void, req: &str) -> String {
    let c = CString::new(req).unwrap();
    unsafe {
        let r = engine_execute(h, c.as_ptr());
        assert!(!r.is_null());
        let s = CStr::from_ptr(r).to_str().unwrap().to_string();
        engine_free_string(r);
        s
    }
}

#[test]
fn realistic_row_queries_do_not_panic() {
    let path = CString::new(":memory:").unwrap();
    let h = engine_open(path.as_ptr());
    assert!(!h.is_null());

    let reg = r#"{"cmd":"registerSource","args":["{\"source_id\":\"api\",\"format\":\"Json\",\"collection\":\"bench_real\",\"natural_key_field\":\"id\",\"timestamp_field\":null,\"priority\":10}"]}"#;
    assert!(exec(h, reg).contains("\"ok\":true"));

    let mut rows: Vec<serde_json::Value> = vec![];
    for i in 0..1000 {
        rows.push(serde_json::json!({
            "id": format!("rec_0_{i:07}"),
            "uuid": format!("u-{i}"),
            "first_name": "Ann", "last_name": "Chen",
            "email": format!("a{i}@x.com"), "phone": format!("+61 4{i:08}"),
            "address_line1": format!("{i} George St"), "address_city": "Sydney",
            "address_state": "NSW", "address_postcode": "2000",
            "billing_city": "Perth", "billing_postcode": "6000",
            "company": "Acme", "job_title": "Analyst", "status": "active",
            "is_active": true, "email_verified": false,
            "balance": (i as f64) + 0.5, "lifetime_value": (i * 3) as f64 + 0.25,
            "currency": "AUD",
            "created_at": "2026-01-01T00:00:00Z", "updated_at": "2026-07-16T00:00:00Z",
            "notes": "Follow-up scheduled after quarterly account review. ".repeat(6),
        }));
    }
    let payload = serde_json::to_string(&rows).unwrap();
    let req = serde_json::json!({"cmd": "ingest", "args": ["api", payload]}).to_string();
    assert!(exec(h, &req).contains("\"ok\":true"), "ingest failed");

    let col = CString::new("bench_real").unwrap();
    let fields = CString::new(FIELDS_CSV).unwrap();
    for round in 0..20 {
        let scan = exec(h, r#"{"cmd":"scan","args":["entry:bench_real:*"]}"#);
        assert!(scan.contains("\"ok\":true"), "scan failed round {round}");
        let mut len = 0usize;
        let p = unsafe { engine_query_entries_bin(h, col.as_ptr(), &mut len) };
        assert!(!p.is_null(), "bin null round {round}");
        unsafe { engine_free_bytes(p, len) };
        let mut slen = 0usize;
        let sp = unsafe { engine_query_entries_schema_bin(h, col.as_ptr(), fields.as_ptr(), &mut slen) };
        assert!(!sp.is_null(), "schema null round {round}");
        let bytes = unsafe { std::slice::from_raw_parts(sp, slen) }.to_vec();
        unsafe { engine_free_bytes(sp, slen) };
        assert_eq!(u32::from_le_bytes(bytes[0..4].try_into().unwrap()), 23, "round {round}");
    }
    engine_close(h);
}
