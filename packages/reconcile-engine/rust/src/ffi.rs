use crate::binenc::encode_entries;
use crate::dispatch::execute;
use crate::engine::Engine;
use rusqlite::params;
use std::cell::RefCell;
use std::ffi::{c_char, c_void, CStr, CString};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

type EventCb = extern "C" fn(*mut c_void, *const c_char, *const c_char);

/// ctx is an opaque pointer owned by the C++ side; it must outlive the engine.
struct CallbackHolder {
    ctx: usize, // stored as usize so the holder is Send
    cb: EventCb,
}

pub struct EngineFfi {
    inner: Mutex<Engine>,
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
        Ok(e) => Box::into_raw(Box::new(EngineFfi { inner: Mutex::new(e) })) as *mut c_void,
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
                let ch = CString::new(channel).unwrap();
                let pl = CString::new(payload).unwrap();
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
        unsafe { drop(Box::from_raw(handle as *mut EngineFfi)) };
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
}
