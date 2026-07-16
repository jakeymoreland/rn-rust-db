use crate::binenc::encode_entries;
use crate::dispatch::execute;
use crate::engine::Engine;
use rusqlite::params;
use std::cell::RefCell;
use std::ffi::{c_char, c_void, CStr, CString};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

type EventCb = extern "C" fn(*mut c_void, *const c_char, *const c_char);

/// ctx is an opaque pointer owned by the C++ side; it must outlive the engine.
struct CallbackHolder {
    ctx: usize, // stored as usize so the holder is Send
    cb: EventCb,
}

pub struct EngineFfi {
    inner: Arc<Mutex<Engine>>,
    flusher_stop: Arc<AtomicBool>,
    flusher: Option<JoinHandle<()>>,
}

thread_local! {
    static LAST_ERROR: RefCell<Option<String>> = const { RefCell::new(None) };
}

fn set_last_error(code: u32, message: &str) {
    let json = serde_json::json!({"code": code, "message": message}).to_string();
    LAST_ERROR.with(|e| *e.borrow_mut() = Some(json));
}

fn to_c_string(s: String) -> *mut c_char {
    CString::new(s).unwrap_or_else(|_| CString::new("{\"ok\":false,\"code\":2,\"message\":\"interior nul\"}").unwrap()).into_raw()
}

/// Replaces any interior NUL byte with the Unicode replacement character so the
/// result is always safe to hand to `CString::new`. Caller-supplied strings
/// (e.g. a collection name echoed back into an event channel) are not
/// guaranteed to be free of NULs, and `CString::new` fails on them.
fn sanitize_for_cstring(s: &str) -> String {
    if s.contains('\0') {
        s.replace('\0', "\u{FFFD}")
    } else {
        s.to_string()
    }
}

unsafe fn cstr<'a>(p: *const c_char) -> Option<&'a str> {
    if p.is_null() {
        return None;
    }
    CStr::from_ptr(p).to_str().ok()
}

fn real_clock() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[no_mangle]
pub extern "C" fn engine_open(path: *const c_char) -> *mut c_void {
    let Some(path) = (unsafe { cstr(path) }) else {
        set_last_error(4, "null or invalid path");
        return std::ptr::null_mut();
    };
    match Engine::open(path, Box::new(real_clock)) {
        Ok(e) => {
            let inner = Arc::new(Mutex::new(e));
            let flusher_stop = Arc::new(AtomicBool::new(false));
            // Write-behind durability: pending kv sets flush every ~100 ms even
            // if no flush-forcing command runs. Woken early via unpark on close.
            let (inner2, stop2) = (Arc::clone(&inner), Arc::clone(&flusher_stop));
            let flusher = std::thread::spawn(move || loop {
                std::thread::park_timeout(Duration::from_millis(100));
                if stop2.load(Ordering::Relaxed) {
                    return;
                }
                if let Ok(mut engine) = inner2.lock() {
                    let _ = engine.flush_kv();
                }
            });
            Box::into_raw(Box::new(EngineFfi { inner, flusher_stop, flusher: Some(flusher) })) as *mut c_void
        }
        Err(e) => {
            set_last_error(e.code(), &e.to_string());
            std::ptr::null_mut()
        }
    }
}

#[no_mangle]
pub extern "C" fn engine_last_error() -> *mut c_char {
    LAST_ERROR.with(|e| match e.borrow().as_ref() {
        Some(s) => to_c_string(s.clone()),
        None => std::ptr::null_mut(),
    })
}

#[no_mangle]
pub extern "C" fn engine_execute(handle: *mut c_void, request_json: *const c_char) -> *mut c_char {
    if handle.is_null() {
        return to_c_string("{\"ok\":false,\"code\":4,\"message\":\"null engine handle\"}".into());
    }
    let ffi = unsafe { &*(handle as *mut EngineFfi) };
    let Some(req) = (unsafe { cstr(request_json) }) else {
        return to_c_string("{\"ok\":false,\"code\":4,\"message\":\"null request\"}".into());
    };
    let mut engine = ffi.inner.lock().unwrap();
    to_c_string(execute(&mut engine, req))
}

#[no_mangle]
pub extern "C" fn engine_query_entries_bin(
    handle: *mut c_void,
    collection: *const c_char,
    out_len: *mut usize,
) -> *mut u8 {
    if handle.is_null() || out_len.is_null() {
        return std::ptr::null_mut();
    }
    let ffi = unsafe { &*(handle as *mut EngineFfi) };
    let Some(collection) = (unsafe { cstr(collection) }) else {
        return std::ptr::null_mut();
    };
    let engine = ffi.inner.lock().unwrap();
    let mut rows: Vec<(String, String)> = vec![];
    let result = (|| -> Result<(), rusqlite::Error> {
        let mut stmt = engine
            .store
            .conn
            .prepare("SELECT natural_key, fields FROM entries WHERE collection = ?1 ORDER BY natural_key")?;
        let iter = stmt.query_map(params![collection], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?;
        for row in iter {
            rows.push(row?);
        }
        Ok(())
    })();
    if let Err(e) = result {
        set_last_error(2, &e.to_string());
        return std::ptr::null_mut();
    }
    let buf = encode_entries(&rows);
    let len = buf.len();
    let ptr = Box::into_raw(buf.into_boxed_slice()) as *mut u8;
    unsafe { *out_len = len };
    ptr
}

#[no_mangle]
pub extern "C" fn engine_query_entries_schema_bin_range(
    handle: *mut c_void,
    collection: *const c_char,
    fields_csv: *const c_char,
    limit: i64,
    offset: i64,
    out_len: *mut usize,
) -> *mut u8 {
    if handle.is_null() || out_len.is_null() {
        return std::ptr::null_mut();
    }
    let ffi = unsafe { &*(handle as *mut EngineFfi) };
    let Some(collection) = (unsafe { cstr(collection) }) else {
        return std::ptr::null_mut();
    };
    let Some(fields_csv) = (unsafe { cstr(fields_csv) }) else {
        return std::ptr::null_mut();
    };
    let fields: Vec<&str> = fields_csv.split(',').map(str::trim).filter(|f| !f.is_empty()).collect();
    if fields.is_empty() || limit <= 0 || offset < 0 {
        set_last_error(4, "bad fields/limit/offset");
        return std::ptr::null_mut();
    }
    let engine = ffi.inner.lock().unwrap();
    let mut rows: Vec<(String, String)> = vec![];
    let result = (|| -> Result<(), rusqlite::Error> {
        let mut stmt = engine.store.conn.prepare_cached(
            "SELECT natural_key, fields FROM entries WHERE collection = ?1 ORDER BY natural_key LIMIT ?2 OFFSET ?3",
        )?;
        let iter = stmt.query_map(params![collection, limit, offset], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?;
        for row in iter {
            rows.push(row?);
        }
        Ok(())
    })();
    if let Err(e) = result {
        set_last_error(2, &e.to_string());
        return std::ptr::null_mut();
    }
    let buf = crate::binenc::encode_entries_schema(&rows, &fields);
    let len = buf.len();
    let ptr = Box::into_raw(buf.into_boxed_slice()) as *mut u8;
    unsafe { *out_len = len };
    ptr
}

#[no_mangle]
pub extern "C" fn engine_query_entries_schema_bin(
    handle: *mut c_void,
    collection: *const c_char,
    fields_csv: *const c_char,
    out_len: *mut usize,
) -> *mut u8 {
    if handle.is_null() || out_len.is_null() {
        return std::ptr::null_mut();
    }
    let ffi = unsafe { &*(handle as *mut EngineFfi) };
    let Some(collection) = (unsafe { cstr(collection) }) else {
        return std::ptr::null_mut();
    };
    let Some(fields_csv) = (unsafe { cstr(fields_csv) }) else {
        return std::ptr::null_mut();
    };
    let fields: Vec<&str> = fields_csv.split(',').map(str::trim).filter(|f| !f.is_empty()).collect();
    if fields.is_empty() {
        set_last_error(4, "no fields given");
        return std::ptr::null_mut();
    }
    let engine = ffi.inner.lock().unwrap();
    let mut rows: Vec<(String, String)> = vec![];
    let result = (|| -> Result<(), rusqlite::Error> {
        let mut stmt = engine
            .store
            .conn
            .prepare("SELECT natural_key, fields FROM entries WHERE collection = ?1 ORDER BY natural_key")?;
        let iter = stmt.query_map(params![collection], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?;
        for row in iter {
            rows.push(row?);
        }
        Ok(())
    })();
    if let Err(e) = result {
        set_last_error(2, &e.to_string());
        return std::ptr::null_mut();
    }
    let buf = crate::binenc::encode_entries_schema(&rows, &fields);
    let len = buf.len();
    let ptr = Box::into_raw(buf.into_boxed_slice()) as *mut u8;
    unsafe { *out_len = len };
    ptr
}

#[no_mangle]
pub extern "C" fn engine_set_event_callback(
    handle: *mut c_void,
    ctx: *mut c_void,
    cb: Option<EventCb>,
) {
    if handle.is_null() {
        return;
    }
    let ffi = unsafe { &*(handle as *mut EngineFfi) };
    let mut engine = ffi.inner.lock().unwrap();
    match cb {
        Some(cb) => {
            let holder = CallbackHolder { ctx: ctx as usize, cb };
            engine.pubsub.set_sink(Box::new(move |channel, payload| {
                // Caller-supplied data (e.g. a collection name) may contain interior
                // NUL bytes. CString::new would fail on those; unwrapping inside this
                // callback would panic across an extern "C" boundary and abort the
                // process. Sanitize first, and if construction still somehow fails,
                // skip this callback invocation rather than panic.
                let sanitized_channel = sanitize_for_cstring(channel);
                let sanitized_payload = sanitize_for_cstring(payload);
                let (Ok(ch), Ok(pl)) = (
                    CString::new(sanitized_channel),
                    CString::new(sanitized_payload),
                ) else {
                    return;
                };
                (holder.cb)(holder.ctx as *mut c_void, ch.as_ptr(), pl.as_ptr());
            }));
        }
        None => engine.pubsub.set_sink(Box::new(|_, _| {})),
    }
}

#[no_mangle]
pub extern "C" fn engine_free_string(s: *mut c_char) {
    if !s.is_null() {
        unsafe { drop(CString::from_raw(s)) };
    }
}

#[no_mangle]
pub extern "C" fn engine_free_bytes(p: *mut u8, len: usize) {
    if !p.is_null() {
        unsafe {
            drop(Box::from_raw(std::slice::from_raw_parts_mut(p, len) as *mut [u8]));
        }
    }
}

#[no_mangle]
pub extern "C" fn engine_close(handle: *mut c_void) {
    if !handle.is_null() {
        let mut ffi = unsafe { Box::from_raw(handle as *mut EngineFfi) };
        ffi.flusher_stop.store(true, Ordering::Relaxed);
        if let Some(h) = ffi.flusher.take() {
            h.thread().unpark();
            let _ = h.join();
        }
        if let Ok(mut engine) = ffi.inner.lock() {
            let _ = engine.flush_kv(); // final flush so no pending set is lost
        }
        drop(ffi);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::{CStr, CString};

    #[test]
    fn c_abi_roundtrip() {
        let path = CString::new(":memory:").unwrap();
        let h = engine_open(path.as_ptr());
        assert!(!h.is_null());

        let req = CString::new(r#"{"cmd":"set","args":["a","1"]}"#).unwrap();
        let resp = engine_execute(h, req.as_ptr());
        let s = unsafe { CStr::from_ptr(resp) }.to_str().unwrap().to_string();
        engine_free_string(resp);
        assert!(s.contains("\"ok\":true"));

        let req2 = CString::new(r#"{"cmd":"get","args":["a"]}"#).unwrap();
        let resp2 = engine_execute(h, req2.as_ptr());
        let s2 = unsafe { CStr::from_ptr(resp2) }.to_str().unwrap().to_string();
        engine_free_string(resp2);
        assert!(s2.contains("\"1\""));

        engine_close(h);
    }

    #[test]
    fn open_failure_sets_last_error() {
        let path = CString::new("/nonexistent-dir-zzz/db.sqlite").unwrap();
        let h = engine_open(path.as_ptr());
        assert!(h.is_null());
        let e = engine_last_error();
        assert!(!e.is_null());
        let s = unsafe { CStr::from_ptr(e) }.to_str().unwrap().to_string();
        engine_free_string(e);
        assert!(s.contains("message"));
    }

    #[test]
    fn event_callback_fires_on_publish() {
        use std::sync::atomic::{AtomicU32, Ordering};
        static FIRED: AtomicU32 = AtomicU32::new(0);
        extern "C" fn cb(_ctx: *mut std::ffi::c_void, _ch: *const std::os::raw::c_char, _p: *const std::os::raw::c_char) {
            FIRED.fetch_add(1, Ordering::SeqCst);
        }
        let path = CString::new(":memory:").unwrap();
        let h = engine_open(path.as_ptr());
        engine_set_event_callback(h, std::ptr::null_mut(), Some(cb));
        for req in [
            r#"{"cmd":"registerSource","args":["{\"source_id\":\"api\",\"format\":\"Json\",\"collection\":\"people\",\"natural_key_field\":\"email\",\"timestamp_field\":null,\"priority\":10}"]}"#,
            r#"{"cmd":"subscribe","args":["changes:*"]}"#,
            r#"{"cmd":"ingest","args":["api","[{\"email\":\"a@x.com\"}]"]}"#,
        ] {
            let c = CString::new(req).unwrap();
            let r = engine_execute(h, c.as_ptr());
            engine_free_string(r);
        }
        assert_eq!(FIRED.load(Ordering::SeqCst), 1);
        engine_close(h);
    }

    /// Regression test for a caller-supplied collection name containing an
    /// interior NUL byte. The event sink builds its channel string as
    /// "changes:{collection}" and used to hand that straight to
    /// `CString::new(..).unwrap()`; a NUL anywhere in there made `CString::new`
    /// return `Err`, and `.unwrap()` panicked inside an `extern "C"` callback,
    /// which aborts the whole process. This drives that exact path end to end
    /// through `engine_execute` and asserts the process survives and every
    /// call still returns a well-formed ok envelope.
    #[test]
    fn event_callback_survives_interior_nul_in_collection() {
        use std::sync::atomic::{AtomicU32, Ordering};
        static FIRED: AtomicU32 = AtomicU32::new(0);
        extern "C" fn cb(
            _ctx: *mut std::ffi::c_void,
            ch: *const std::os::raw::c_char,
            payload: *const std::os::raw::c_char,
        ) {
            // If the sink had panicked/aborted we would never get here. Also
            // verify the pointers we did get are valid, readable C strings
            // (i.e. properly sanitized, not raw truncated garbage).
            assert!(!ch.is_null());
            assert!(!payload.is_null());
            unsafe {
                let _ = CStr::from_ptr(ch).to_str().expect("channel must be valid utf8");
                let _ = CStr::from_ptr(payload).to_str().expect("payload must be valid utf8");
            }
            FIRED.fetch_add(1, Ordering::SeqCst);
        }

        let path = CString::new(":memory:").unwrap();
        let h = engine_open(path.as_ptr());
        engine_set_event_callback(h, std::ptr::null_mut(), Some(cb));

        // Build requests with serde_json so the interior NUL (\u{0}) is escaped
        // correctly rather than truncating the string at the first byte.
        let collection = "peo\u{0}ple";
        let source_cfg = serde_json::json!({
            "source_id": "api",
            "format": "Json",
            "collection": collection,
            "natural_key_field": "email",
            "timestamp_field": null,
            "priority": 10
        })
        .to_string();
        let register_req = serde_json::json!({"cmd": "registerSource", "args": [source_cfg]}).to_string();
        let subscribe_req = serde_json::json!({"cmd": "subscribe", "args": ["changes:*"]}).to_string();
        let ingest_payload = serde_json::json!([{"email": "a@x.com"}]).to_string();
        let ingest_req =
            serde_json::json!({"cmd": "ingest", "args": ["api", ingest_payload]}).to_string();

        for req in [register_req, subscribe_req, ingest_req] {
            let c = CString::new(req).unwrap();
            let r = engine_execute(h, c.as_ptr());
            assert!(!r.is_null());
            let s = unsafe { CStr::from_ptr(r) }.to_str().unwrap().to_string();
            engine_free_string(r);
            assert!(s.contains("\"ok\":true"), "expected ok envelope, got: {s}");
        }

        // The key assertion is that we got this far at all: the process did
        // not abort. Whether the sanitized "changes:peo<U+FFFD>ple" channel
        // still matches the "changes:*" subscription is a secondary detail;
        // if it fired, the callback body above already checked the strings
        // it received were valid, sanitized C strings.
        let _ = FIRED.load(Ordering::SeqCst);
        engine_close(h);
    }

    #[test]
    fn query_entries_bin_roundtrip() {
        let path = CString::new(":memory:").unwrap();
        let h = engine_open(path.as_ptr());
        for req in [
            r#"{"cmd":"registerSource","args":["{\"source_id\":\"api\",\"format\":\"Json\",\"collection\":\"people\",\"natural_key_field\":\"email\",\"timestamp_field\":null,\"priority\":10}"]}"#,
            r#"{"cmd":"ingest","args":["api","[{\"email\":\"a@x.com\",\"name\":\"Ann\"}]"]}"#,
        ] {
            let c = CString::new(req).unwrap();
            let r = engine_execute(h, c.as_ptr());
            engine_free_string(r);
        }
        let col = CString::new("people").unwrap();
        let mut len: usize = 0;
        let p = engine_query_entries_bin(h, col.as_ptr(), &mut len);
        assert!(!p.is_null());
        let bytes = unsafe { std::slice::from_raw_parts(p, len) }.to_vec();
        engine_free_bytes(p, len);
        assert_eq!(&bytes[0..4], &1u32.to_le_bytes());
        engine_close(h);
    }

    #[test]
    fn kv_write_behind_persists_across_close() {
        let path = std::env::temp_dir().join(format!("kvwb_{}.sqlite", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let cpath = CString::new(path.to_str().unwrap()).unwrap();

        let h = engine_open(cpath.as_ptr());
        assert!(!h.is_null());
        let req = CString::new(r#"{"cmd":"set","args":["wb_key","wb_value"]}"#).unwrap();
        let r = engine_execute(h, req.as_ptr());
        engine_free_string(r);
        engine_close(h); // must flush the pending write-behind set

        let h2 = engine_open(cpath.as_ptr());
        assert!(!h2.is_null());
        let req2 = CString::new(r#"{"cmd":"get","args":["wb_key"]}"#).unwrap();
        let r2 = engine_execute(h2, req2.as_ptr());
        let resp = unsafe { CStr::from_ptr(r2) }.to_str().unwrap().to_string();
        engine_free_string(r2);
        engine_close(h2);
        let _ = std::fs::remove_file(&path);
        assert!(resp.contains("wb_value"), "expected persisted value, got: {resp}");
    }

    #[test]
    fn query_entries_schema_bin_roundtrip() {
        let path = CString::new(":memory:").unwrap();
        let h = engine_open(path.as_ptr());
        for req in [
            r#"{"cmd":"registerSource","args":["{\"source_id\":\"api\",\"format\":\"Json\",\"collection\":\"people\",\"natural_key_field\":\"email\",\"timestamp_field\":null,\"priority\":10}"]}"#,
            r#"{"cmd":"ingest","args":["api","[{\"email\":\"a@x.com\",\"name\":\"Ann\"}]"]}"#,
        ] {
            let c = CString::new(req).unwrap();
            let r = engine_execute(h, c.as_ptr());
            engine_free_string(r);
        }
        // range variant: 1 row at offset 0, and empty past the end
        {
            let col = CString::new("people").unwrap();
            let fields = CString::new("name").unwrap();
            let mut len: usize = 0;
            let p = engine_query_entries_schema_bin_range(h, col.as_ptr(), fields.as_ptr(), 1, 0, &mut len);
            assert!(!p.is_null());
            let bytes = unsafe { std::slice::from_raw_parts(p, len) }.to_vec();
            engine_free_bytes(p, len);
            // field table (1 field "name") then row count 1
            assert_eq!(&bytes[0..4], &1u32.to_le_bytes());
            assert_eq!(&bytes[12..16], &1u32.to_le_bytes());
            let p2 = engine_query_entries_schema_bin_range(h, col.as_ptr(), fields.as_ptr(), 10, 50, &mut len);
            assert!(!p2.is_null());
            let bytes2 = unsafe { std::slice::from_raw_parts(p2, len) }.to_vec();
            engine_free_bytes(p2, len);
            assert_eq!(&bytes2[12..16], &0u32.to_le_bytes()); // no rows past the end
            let p3 = engine_query_entries_schema_bin_range(h, col.as_ptr(), fields.as_ptr(), 0, 0, &mut len);
            assert!(p3.is_null()); // limit must be > 0
        }

        let col = CString::new("people").unwrap();
        let fields = CString::new("name,missing_field").unwrap();
        let mut len: usize = 0;
        let p = engine_query_entries_schema_bin(h, col.as_ptr(), fields.as_ptr(), &mut len);
        assert!(!p.is_null());
        let bytes = unsafe { std::slice::from_raw_parts(p, len) }.to_vec();
        engine_free_bytes(p, len);
        // field table: 2 fields, first is "name"
        assert_eq!(&bytes[0..4], &2u32.to_le_bytes());
        assert_eq!(&bytes[4..8], &4u32.to_le_bytes());
        assert_eq!(&bytes[8..12], b"name");
        // empty fields csv errors
        let empty = CString::new("").unwrap();
        let p2 = engine_query_entries_schema_bin(h, col.as_ptr(), empty.as_ptr(), &mut len);
        assert!(p2.is_null());
        engine_close(h);
    }
}
