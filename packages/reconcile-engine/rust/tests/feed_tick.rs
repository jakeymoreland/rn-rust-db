//! Reproduces the betting-feed sequence exactly: a full snapshot through
//! engine_ingest_direct, then a delta tick that republishes the key plus a few
//! volatile fields with a newer timestamp.
use reconcile_engine::ffi::*;
use std::ffi::{CStr, CString};
use std::os::raw::c_void;

const CFG: &str = r#"{"source_id":"feed","format":"Json","collection":"selections","natural_key_field":"selection_id","timestamp_field":"updated_at","priority":10}"#;

fn exec(h: *mut c_void, req: &str) -> String {
    let c = CString::new(req).unwrap();
    unsafe { let r = engine_execute(h, c.as_ptr());
        let s = CStr::from_ptr(r).to_str().unwrap().to_string(); engine_free_string(r); s }
}

fn direct(h: *mut c_void, payload: &str) -> serde_json::Value {
    let src = CString::new("feed").unwrap();
    let p = CString::new(payload).unwrap();
    unsafe {
        let r = engine_ingest_direct(h, src.as_ptr(), p.as_ptr());
        let s = CStr::from_ptr(r).to_str().unwrap().to_string();
        engine_free_string(r);
        let v: serde_json::Value = serde_json::from_str(&s).unwrap();
        assert_eq!(v["ok"], true, "{s}");
        v["value"].clone()
    }
}

#[test]
fn delta_tick_after_snapshot_reports_changed_keys() {
    let path = CString::new(":memory:").unwrap();
    let h = engine_open(path.as_ptr());
    exec(h, &format!(r#"{{"cmd":"registerSource","args":[{}]}}"#, serde_json::to_string(CFG).unwrap()));

    // Full snapshot, 18-ish fields per row (rev 0).
    let snapshot =
        r#"[{"selection_id":"s0","event_id":"e0","event_name":"A v B","competition":"PL","market_id":"m0","market_name":"Match Odds","market_type":"MATCH_ODDS","start_time":"2026-08-06T19:45:00Z","runner_name":"A","runner_id":47000,"sort_order":1,"in_play":false,"status":"ACTIVE","back_price":7.97,"back_size":4523.09,"lay_price":8,"lay_size":2406.7,"last_traded_price":7.97,"total_matched":233403.9,"updated_at":"2026-07-25T17:20:00.000Z"}]"#;
    let v = direct(h, snapshot);
    assert_eq!(v["inserted"], 1, "{v}");

    // Delta tick: key + volatile fields only, 250 ms newer (rev 1).
    let tick = r#"[{"selection_id":"s0","back_price":3.7,"back_size":3976.28,"lay_price":3.74,"lay_size":2466.39,"last_traded_price":3.7,"total_matched":253469.37,"updated_at":"2026-07-25T17:20:00.250Z"}]"#;
    let v = direct(h, tick);
    eprintln!("tick summary: {v}");
    assert_eq!(v["updated"], 1, "delta tick did not update the row: {v}");
    let keys = v["changed_keys"]["selections"]
        .as_array()
        .expect("changed_keys.selections missing after a delta tick");
    assert_eq!(keys.len(), 1, "{v}");
    engine_close(h);
}
