// Every function here is a `#[no_mangle] extern "C"` boundary export. They take
// raw pointers by contract with the C++/JSI caller (documented in engine.h) and
// there are no safe Rust callers to protect, so clippy's not_unsafe_ptr_arg_deref
// is suppressed module-wide rather than forcing `unsafe fn` on the whole ABI.
#![allow(clippy::not_unsafe_ptr_arg_deref)]

use crate::binenc::encode_entries;
use crate::dispatch::execute;
use crate::engine::Engine;
use rusqlite::params;
use std::cell::RefCell;
use std::collections::HashSet;
use std::ffi::{c_char, c_void, CStr, CString};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread::JoinHandle;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Live EngineFfi handle addresses (audit S8). engine_close only frees a handle
/// present here, so a double close or a stale/unknown handle is a safe no-op
/// instead of a double free / use-after-free.
fn live_handles() -> &'static Mutex<HashSet<usize>> {
    static LIVE: OnceLock<Mutex<HashSet<usize>>> = OnceLock::new();
    LIVE.get_or_init(|| Mutex::new(HashSet::new()))
}

/// Poison-safe engine lock (audit S9): a prior panic while the mutex was held
/// must not turn every later call into an abort. The engine state is
/// SQLite-backed and safe to keep using, so recover the guard.
fn lock_engine(inner: &Mutex<Engine>) -> std::sync::MutexGuard<'_, Engine> {
    inner.lock().unwrap_or_else(|p| p.into_inner())
}

/// Wraps an extern "C" body in catch_unwind (audit S16): a panic reachable from
/// the boundary is contained and mapped to `$fallback` instead of unwinding
/// across the C ABI (which aborts the whole app).
macro_rules! ffi_guard {
    ($fallback:expr, $body:expr) => {
        match catch_unwind(AssertUnwindSafe(|| $body)) {
            Ok(v) => v,
            Err(_) => {
                set_last_error(500, "internal panic in engine FFI");
                $fallback
            }
        }
    };
}

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
    /// The change-event sink lives here, NOT inside the engine mutex, so it can
    /// be invoked after `inner` is unlocked (audit S7/F14). Its own short-lived
    /// lock is never held while `inner` is locked.
    sink: Mutex<Option<crate::pubsub::Sink>>,
}

/// Delivers buffered change events by invoking the sink. MUST be called with
/// the engine `inner` mutex released, so a subscriber callback may re-enter the
/// engine without deadlocking.
fn deliver_events(ffi: &EngineFfi, events: Vec<(String, String)>) {
    if events.is_empty() {
        return;
    }
    if let Ok(guard) = ffi.sink.lock() {
        if let Some(sink) = guard.as_ref() {
            for (channel, payload) in events {
                sink(&channel, &payload);
            }
        }
    }
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
    ffi_guard!(std::ptr::null_mut(), {
        let Some(path) = (unsafe { cstr(path) }) else {
            set_last_error(4, "null or invalid path");
            return std::ptr::null_mut();
        };
        match Engine::open(path, Box::new(real_clock)) {
            Ok(e) => {
                let inner = Arc::new(Mutex::new(e));
                let flusher_stop = Arc::new(AtomicBool::new(false));
                // Write-behind durability: pending kv sets flush every ~100 ms
                // even if no flush-forcing command runs. Woken early on close.
                let (inner2, stop2) = (Arc::clone(&inner), Arc::clone(&flusher_stop));
                let flusher = std::thread::spawn(move || loop {
                    std::thread::park_timeout(Duration::from_millis(100));
                    if stop2.load(Ordering::Relaxed) {
                        return;
                    }
                    let mut engine = lock_engine(&inner2);
                    // Audit S12: record a flush failure so the next command can
                    // surface it, instead of silently retrying forever.
                    if let Err(e) = engine.flush_kv() {
                        engine.sticky_error = Some(e);
                    }
                });
                let handle = Box::into_raw(Box::new(EngineFfi {
                    inner,
                    flusher_stop,
                    flusher: Some(flusher),
                    sink: Mutex::new(None),
                })) as *mut c_void;
                if let Ok(mut live) = live_handles().lock() {
                    live.insert(handle as usize);
                }
                handle
            }
            Err(e) => {
                set_last_error(e.code(), &e.to_string());
                std::ptr::null_mut()
            }
        }
    })
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
    ffi_guard!(
        to_c_string("{\"ok\":false,\"code\":500,\"message\":\"internal panic\"}".into()),
        {
            if handle.is_null() {
                return to_c_string("{\"ok\":false,\"code\":4,\"message\":\"null engine handle\"}".into());
            }
            let ffi = unsafe { &*(handle as *mut EngineFfi) };
            let Some(req) = (unsafe { cstr(request_json) }) else {
                return to_c_string("{\"ok\":false,\"code\":4,\"message\":\"null request\"}".into());
            };
            let (response, events) = {
                let mut engine = lock_engine(&ffi.inner);
                let response = execute(&mut engine, req);
                (response, engine.take_events())
            };
            // Guard released — safe for a subscriber callback to re-enter.
            deliver_events(ffi, events);
            to_c_string(response)
        }
    )
}

#[no_mangle]
pub extern "C" fn engine_query_entries_bin(
    handle: *mut c_void,
    collection: *const c_char,
    out_len: *mut usize,
) -> *mut u8 {
    ffi_guard!(std::ptr::null_mut(), {
        if handle.is_null() || out_len.is_null() {
            return std::ptr::null_mut();
        }
        // Audit F29: define *out_len on every return path so a caller that
        // reads it without checking the NULL return sees 0, not stale memory.
        unsafe { *out_len = 0 };
        let ffi = unsafe { &*(handle as *mut EngineFfi) };
        let Some(collection) = (unsafe { cstr(collection) }) else {
            return std::ptr::null_mut();
        };
        let engine = lock_engine(&ffi.inner);
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
    })
}

/// Ingest without the JSON command envelope: source id and payload cross as
/// plain strings instead of being escaped into a request envelope and parsed
/// twice. Response envelope matches engine_execute's ingest exactly.
fn ingest_response(ffi: &EngineFfi, source_id: &str, payload: &str) -> *mut c_char {
    let (response, events) = {
        let mut engine = lock_engine(&ffi.inner);
        let response = match engine.ingest(source_id, payload) {
            // Audit F30: a serialization failure returns an error envelope
            // rather than unwrap-panicking across the FFI boundary.
            Ok((summary, skipped)) => match serde_json::to_value(&summary) {
                Ok(mut v) => {
                    v["skipped"] = serde_json::json!(skipped);
                    serde_json::json!({"ok": true, "value": v}).to_string()
                }
                Err(e) => serde_json::json!({"ok": false, "code": 2, "message": e.to_string()}).to_string(),
            },
            Err(e) => {
                serde_json::json!({"ok": false, "code": e.code(), "message": e.to_string()}).to_string()
            }
        };
        (response, engine.take_events())
    };
    deliver_events(ffi, events);
    to_c_string(response)
}

#[no_mangle]
pub extern "C" fn engine_ingest_direct(
    handle: *mut c_void,
    source_id: *const c_char,
    payload: *const c_char,
) -> *mut c_char {
    ffi_guard!(
        to_c_string("{\"ok\":false,\"code\":500,\"message\":\"internal panic\"}".into()),
        {
            if handle.is_null() {
                return to_c_string("{\"ok\":false,\"code\":4,\"message\":\"null engine handle\"}".into());
            }
            let ffi = unsafe { &*(handle as *mut EngineFfi) };
            let (Some(source_id), Some(payload)) = (unsafe { cstr(source_id) }, unsafe { cstr(payload) }) else {
                return to_c_string("{\"ok\":false,\"code\":4,\"message\":\"null argument\"}".into());
            };
            ingest_response(ffi, source_id, payload)
        }
    )
}

/// Byte-slice ingest: the payload arrives as (ptr, len) — no NUL-terminated
/// C string, so callers can hand over ArrayBuffer contents without a
/// full-string UTF-8 materialization on the JS thread. The bytes are
/// validated as UTF-8 here (SIMD-fast, no copy).
#[no_mangle]
pub extern "C" fn engine_ingest_bytes(
    handle: *mut c_void,
    source_id: *const c_char,
    payload: *const u8,
    payload_len: usize,
) -> *mut c_char {
    ffi_guard!(
        to_c_string("{\"ok\":false,\"code\":500,\"message\":\"internal panic\"}".into()),
        {
            if handle.is_null() {
                return to_c_string("{\"ok\":false,\"code\":4,\"message\":\"null engine handle\"}".into());
            }
            let ffi = unsafe { &*(handle as *mut EngineFfi) };
            let Some(source_id) = (unsafe { cstr(source_id) }) else {
                return to_c_string("{\"ok\":false,\"code\":4,\"message\":\"null source id\"}".into());
            };
            // Audit F28: reject an over-large length that would violate
            // from_raw_parts' isize::MAX precondition (immediate UB).
            if payload.is_null() || payload_len > isize::MAX as usize {
                return to_c_string("{\"ok\":false,\"code\":4,\"message\":\"null or oversized payload\"}".into());
            }
            let bytes = unsafe { std::slice::from_raw_parts(payload, payload_len) };
            let Ok(payload) = std::str::from_utf8(bytes) else {
                return to_c_string("{\"ok\":false,\"code\":4,\"message\":\"payload is not valid UTF-8\"}".into());
            };
            ingest_response(ffi, source_id, payload)
        }
    )
}

/// Fast-path kv get: returns the value (free with engine_free_string) or NULL
/// when the key is missing or on error (see engine_last_error).
#[no_mangle]
pub extern "C" fn engine_kv_get(handle: *mut c_void, key: *const c_char) -> *mut c_char {
    ffi_guard!(std::ptr::null_mut(), {
        if handle.is_null() {
            return std::ptr::null_mut();
        }
        let ffi = unsafe { &*(handle as *mut EngineFfi) };
        let Some(key) = (unsafe { cstr(key) }) else {
            return std::ptr::null_mut();
        };
        let mut engine = lock_engine(&ffi.inner);
        let now = engine.now();
        match crate::commands::get(&mut engine, key, now) {
            Ok(Some(v)) => to_c_string(v),
            Ok(None) => std::ptr::null_mut(),
            Err(e) => {
                set_last_error(e.code(), &e.to_string());
                std::ptr::null_mut()
            }
        }
    })
}

/// Fast-path kv get that distinguishes a miss from an error (audit F40).
/// Returns the value (free with engine_free_string) or NULL. When NULL, writes
/// `*out_err` = 0 for a genuine miss or 1 for a storage error (last_error set).
#[no_mangle]
pub extern "C" fn engine_kv_get2(
    handle: *mut c_void,
    key: *const c_char,
    out_err: *mut i32,
) -> *mut c_char {
    ffi_guard!(std::ptr::null_mut(), {
        if !out_err.is_null() {
            unsafe { *out_err = 0 };
        }
        if handle.is_null() {
            return std::ptr::null_mut();
        }
        let ffi = unsafe { &*(handle as *mut EngineFfi) };
        let Some(key) = (unsafe { cstr(key) }) else {
            return std::ptr::null_mut();
        };
        let mut engine = lock_engine(&ffi.inner);
        let now = engine.now();
        match crate::commands::get(&mut engine, key, now) {
            Ok(Some(v)) => to_c_string(v),
            Ok(None) => std::ptr::null_mut(),
            Err(e) => {
                set_last_error(e.code(), &e.to_string());
                if !out_err.is_null() {
                    unsafe { *out_err = 1 };
                }
                std::ptr::null_mut()
            }
        }
    })
}

/// Fast-path kv set: returns true on success; on failure sets engine_last_error.
#[no_mangle]
pub extern "C" fn engine_kv_set(handle: *mut c_void, key: *const c_char, value: *const c_char) -> bool {
    ffi_guard!(false, {
        if handle.is_null() {
            return false;
        }
        let ffi = unsafe { &*(handle as *mut EngineFfi) };
        let (Some(key), Some(value)) = (unsafe { cstr(key) }, unsafe { cstr(value) }) else {
            return false;
        };
        let mut engine = lock_engine(&ffi.inner);
        match crate::commands::set(&mut engine, key, value) {
            Ok(()) => true,
            Err(e) => {
                set_last_error(e.code(), &e.to_string());
                false
            }
        }
    })
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
    ffi_guard!(std::ptr::null_mut(), {
        if handle.is_null() || out_len.is_null() {
            return std::ptr::null_mut();
        }
        unsafe { *out_len = 0 }; // audit F29
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
        let engine = lock_engine(&ffi.inner);
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
    })
}

#[no_mangle]
pub extern "C" fn engine_query_entries_schema_bin(
    handle: *mut c_void,
    collection: *const c_char,
    fields_csv: *const c_char,
    out_len: *mut usize,
) -> *mut u8 {
    ffi_guard!(std::ptr::null_mut(), {
        if handle.is_null() || out_len.is_null() {
            return std::ptr::null_mut();
        }
        unsafe { *out_len = 0 }; // audit F29
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
        let engine = lock_engine(&ffi.inner);
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
    })
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
    ffi_guard!((), {
    let ffi = unsafe { &*(handle as *mut EngineFfi) };
    // The sink lives on EngineFfi (audit S7), not inside the engine mutex, so
    // events can be delivered after `inner` is unlocked. This short-lived lock
    // is never held while `inner` is locked.
    let mut sink_guard = ffi.sink.lock().unwrap_or_else(|p| p.into_inner());
    match cb {
        Some(cb) => {
            let holder = CallbackHolder { ctx: ctx as usize, cb };
            *sink_guard = Some(Box::new(move |channel: &str, payload: &str| {
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
        None => *sink_guard = None,
    }
    })
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
            drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(p, len)));
        }
    }
}

#[no_mangle]
pub extern "C" fn engine_close(handle: *mut c_void) {
    if handle.is_null() {
        return;
    }
    // Audit S8: only free a handle currently registered as live. Removing it
    // here (atomically) means a concurrent or duplicate close finds it absent
    // and returns without touching freed memory — no double free / UAF.
    {
        let mut live = match live_handles().lock() {
            Ok(l) => l,
            Err(p) => p.into_inner(),
        };
        if !live.remove(&(handle as usize)) {
            return; // unknown or already-closed handle
        }
    }
    ffi_guard!((), {
        let mut ffi = unsafe { Box::from_raw(handle as *mut EngineFfi) };
        ffi.flusher_stop.store(true, Ordering::Relaxed);
        if let Some(h) = ffi.flusher.take() {
            h.thread().unpark();
            let _ = h.join();
        }
        {
            // Poison-safe (audit S9): still flush + checkpoint even if a prior
            // panic poisoned the engine mutex.
            let mut engine = ffi.inner.lock().unwrap_or_else(|p| p.into_inner());
            // Audit S12: report a final-flush failure via last_error instead of
            // dropping acknowledged write-behind sets silently.
            if let Err(e) = engine.flush_kv() {
                set_last_error(e.code(), &format!("final flush failed on close: {e}"));
            }
            // fold the WAL back into the main DB so the next open starts clean
            let _ = engine
                .store
                .conn
                .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()));
        }
        drop(ffi);
    })
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

    // Audit S6/S7/F14: the change-event sink fires AFTER the engine mutex is
    // released, so a callback that synchronously re-enters engine_execute must
    // not deadlock. Before the fix, publish ran under the lock and this
    // re-entrant call would hang the process.
    #[test]
    fn event_callback_may_reenter_engine_without_deadlock() {
        use std::sync::atomic::{AtomicPtr, Ordering};
        static HANDLE: AtomicPtr<c_void> = AtomicPtr::new(std::ptr::null_mut());
        static REENTERED: AtomicBool = AtomicBool::new(false);
        extern "C" fn cb(_ctx: *mut c_void, _ch: *const c_char, _p: *const c_char) {
            let h = HANDLE.load(Ordering::SeqCst);
            if h.is_null() {
                return;
            }
            // Re-enter the engine from inside the event callback.
            let req = CString::new(r#"{"cmd":"get","args":["k"]}"#).unwrap();
            let r = engine_execute(h, req.as_ptr());
            engine_free_string(r);
            REENTERED.store(true, Ordering::SeqCst);
        }
        let path = CString::new(":memory:").unwrap();
        let h = engine_open(path.as_ptr());
        HANDLE.store(h, Ordering::SeqCst);
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
        assert!(REENTERED.load(Ordering::SeqCst), "callback never ran / deadlocked");
        HANDLE.store(std::ptr::null_mut(), Ordering::SeqCst);
        engine_close(h);
    }

    // Audit S16: a panic reachable from an extern "C" fn must be caught and
    // turned into an error envelope, not unwind across the ABI (which aborts
    // the whole app). The process surviving to the assert IS the test.
    #[test]
    fn panic_in_command_is_contained_as_error_envelope() {
        let path = CString::new(":memory:").unwrap();
        let h = engine_open(path.as_ptr());
        let req = CString::new(r#"{"cmd":"__test_panic","args":[]}"#).unwrap();
        let r = engine_execute(h, req.as_ptr());
        let s = unsafe { CStr::from_ptr(r) }.to_str().unwrap().to_string();
        engine_free_string(r);
        assert!(s.contains("\"ok\":false"), "panic not contained: {s}");
        assert!(s.contains("500"), "expected internal-panic code: {s}");
        // Audit S9: the engine must still work after the panic (mutex not left
        // in an abort-cascading poisoned state).
        let req2 = CString::new(r#"{"cmd":"set","args":["a","1"]}"#).unwrap();
        let r2 = engine_execute(h, req2.as_ptr());
        let s2 = unsafe { CStr::from_ptr(r2) }.to_str().unwrap().to_string();
        engine_free_string(r2);
        assert!(s2.contains("\"ok\":true"), "engine dead after panic: {s2}");
        engine_close(h);
    }

    // Audit F40: engine_kv_get2 distinguishes a miss (err flag 0) from a
    // present value.
    #[test]
    fn kv_get2_distinguishes_miss_from_hit() {
        let path = CString::new(":memory:").unwrap();
        let h = engine_open(path.as_ptr());
        let set = CString::new(r#"{"cmd":"set","args":["k","v"]}"#).unwrap();
        engine_free_string(engine_execute(h, set.as_ptr()));

        let key = CString::new("k").unwrap();
        let mut err: i32 = -1;
        let got = engine_kv_get2(h, key.as_ptr(), &mut err);
        assert!(!got.is_null());
        assert_eq!(err, 0);
        let s = unsafe { CStr::from_ptr(got) }.to_str().unwrap().to_string();
        engine_free_string(got);
        assert_eq!(s, "v");

        let missing = CString::new("nope").unwrap();
        let mut err2: i32 = -1;
        let got2 = engine_kv_get2(h, missing.as_ptr(), &mut err2);
        assert!(got2.is_null());
        assert_eq!(err2, 0, "a genuine miss must report err flag 0");
        engine_close(h);
    }

    // Audit S8: a double close must not double-free / crash.
    #[test]
    fn double_close_is_safe() {
        let path = CString::new(":memory:").unwrap();
        let h = engine_open(path.as_ptr());
        engine_close(h);
        engine_close(h); // must be a no-op, not a double free
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
    fn ingest_direct_matches_envelope_semantics() {
        let path = CString::new(":memory:").unwrap();
        let h = engine_open(path.as_ptr());
        let reg = CString::new(
            r#"{"cmd":"registerSource","args":["{\"source_id\":\"api\",\"format\":\"Json\",\"collection\":\"people\",\"natural_key_field\":\"email\",\"timestamp_field\":null,\"priority\":10}"]}"#,
        )
        .unwrap();
        engine_free_string(engine_execute(h, reg.as_ptr()));

        let src = CString::new("api").unwrap();
        let payload = CString::new(r#"[{"email":"a@x.com","name":"Ann"}]"#).unwrap();
        let r = engine_ingest_direct(h, src.as_ptr(), payload.as_ptr());
        let resp = unsafe { CStr::from_ptr(r) }.to_str().unwrap().to_string();
        engine_free_string(r);
        assert!(resp.contains("\"ok\":true"), "{resp}");
        assert!(resp.contains("\"inserted\":1"), "{resp}");
        // identical re-ingest hits the payload-hash skip, same as execute path
        let r2 = engine_ingest_direct(h, src.as_ptr(), payload.as_ptr());
        let resp2 = unsafe { CStr::from_ptr(r2) }.to_str().unwrap().to_string();
        engine_free_string(r2);
        assert!(resp2.contains("\"skipped\":true"), "{resp2}");
        // unknown source -> error envelope, same shape as dispatch
        let bad = CString::new("nope").unwrap();
        let r3 = engine_ingest_direct(h, bad.as_ptr(), payload.as_ptr());
        let resp3 = unsafe { CStr::from_ptr(r3) }.to_str().unwrap().to_string();
        engine_free_string(r3);
        assert!(resp3.contains("\"ok\":false"), "{resp3}");
        engine_close(h);
    }

    #[test]
    fn ingest_bytes_matches_string_path() {
        let path = CString::new(":memory:").unwrap();
        let h = engine_open(path.as_ptr());
        let reg = CString::new(
            r#"{"cmd":"registerSource","args":["{\"source_id\":\"api\",\"format\":\"Json\",\"collection\":\"people\",\"natural_key_field\":\"email\",\"timestamp_field\":null,\"priority\":10}"]}"#,
        )
        .unwrap();
        engine_free_string(engine_execute(h, reg.as_ptr()));

        let src = CString::new("api").unwrap();
        let payload = r#"[{"email":"b@x.com","name":"Bób ünïcödé"}]"#; // multibyte utf-8
        let r = engine_ingest_bytes(h, src.as_ptr(), payload.as_ptr(), payload.len());
        let resp = unsafe { CStr::from_ptr(r) }.to_str().unwrap().to_string();
        engine_free_string(r);
        assert!(resp.contains("\"inserted\":1"), "{resp}");
        // invalid utf-8 rejected cleanly
        let bad: &[u8] = &[b'[', 0xFF, 0xFE, b']'];
        let r2 = engine_ingest_bytes(h, src.as_ptr(), bad.as_ptr(), bad.len());
        let resp2 = unsafe { CStr::from_ptr(r2) }.to_str().unwrap().to_string();
        engine_free_string(r2);
        assert!(resp2.contains("not valid UTF-8"), "{resp2}");
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
