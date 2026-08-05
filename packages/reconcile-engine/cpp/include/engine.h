#pragma once
#include <stdbool.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef void* engine_handle_t;
typedef void (*engine_event_cb)(void* ctx, const char* channel, const char* payload_json);

/* Returns NULL on failure; see engine_last_error(). */
engine_handle_t engine_open(const char* path);

/*
 * Thread-local error as {"code":n,"message":"..."} JSON, or NULL. Free with
 * engine_free_string. Errno-style: it must be read on the SAME thread that
 * made the failing call, immediately afterward, before that thread makes any
 * other engine_* call. It is NOT cleared on success, so calling it after a
 * successful call (or from a different thread) may return a stale error from
 * an earlier failure.
 */
char* engine_last_error(void);

/* Executes a {"cmd":...,"args":[...]} request; returns response JSON. Free with engine_free_string. */
char* engine_execute(engine_handle_t engine, const char* request_json);

/* True when the request is a pure store read (hget/hgetall/hmgetall), so the
 * caller can run it off the write path. False for null/invalid input — the safe
 * default is "treat it as a write". Mirrors dispatch::is_read_only_cmd. */
bool engine_command_is_read_only(const char* request_json);

/* Binary rows: LE [u32 count]([u32 klen][key][u32 jlen][fields-json])*. Free with engine_free_bytes. */
unsigned char* engine_query_entries_bin(engine_handle_t engine, const char* collection, size_t* out_len);

/*
 * Schema-packed binary rows: LE [u32 nFields]([u32 len][name])* [u32 count]
 * then per row [u32 klen][key] and one [u32 vlen][value] per field in table
 * order (vlen = 0xFFFFFFFF marks a missing/null field). fields_csv is a
 * comma-separated field list. Free with engine_free_bytes.
 */
unsigned char* engine_query_entries_schema_bin(engine_handle_t engine, const char* collection, const char* fields_csv, size_t* out_len);

/* Ingest without the JSON command envelope. Returns the same response envelope JSON as engine_execute's ingest. Free with engine_free_string. */
char* engine_ingest_direct(engine_handle_t engine, const char* source_id, const char* payload);

/*
 * Byte-slice ingest: payload as (ptr, len) — no NUL-terminated string needed,
 * so ArrayBuffer contents cross without full string materialization. Bytes are
 * UTF-8-validated. The caller MUST ensure `payload` points to at least
 * `payload_len` valid, readable bytes and that `payload_len <= PTRDIFF_MAX`;
 * an over-claimed length is undefined behavior. Free result with
 * engine_free_string.
 */
char* engine_ingest_bytes(engine_handle_t engine, const char* source_id, const unsigned char* payload, size_t payload_len);

/* Fast-path kv get: returns the value (free with engine_free_string) or NULL when missing/error. */
char* engine_kv_get(engine_handle_t engine, const char* key);

/*
 * Like engine_kv_get, but distinguishes a miss from a storage error: on a NULL
 * return, *out_err is 0 for a genuine missing key or 1 for an error (read
 * engine_last_error). out_err may be NULL if the caller does not care.
 */
char* engine_kv_get2(engine_handle_t engine, const char* key, int* out_err);

/* Fast-path kv set: returns true on success (memory-first write-behind; see engine docs). */
bool engine_kv_set(engine_handle_t engine, const char* key, const char* value);

/* Windowed variant of engine_query_entries_schema_bin: rows [offset, offset+limit) ordered by natural_key. limit must be > 0, offset >= 0. */
unsigned char* engine_query_entries_schema_bin_range(engine_handle_t engine, const char* collection, const char* fields_csv, long long limit, long long offset, size_t* out_len);

/*
 * Registers cb to be invoked once per matching pubsub event. cb fires from the
 * FFI call that produced the events (e.g. engine_execute / engine_ingest_*),
 * AFTER the engine's internal mutex has been released — so it is now safe to
 * call engine_* functions from inside cb without deadlocking. The channel and
 * payload pointers are only valid for the duration of the call; copy them out
 * before returning. Pass cb = NULL to clear the callback.
 */
void engine_set_event_callback(engine_handle_t engine, void* ctx, engine_event_cb cb);

void engine_free_string(char* s);

/* len must be exactly the value written to out_len by the call that produced p (e.g. engine_query_entries_bin). Any other value is undefined behavior. */
void engine_free_bytes(unsigned char* p, size_t len);

/*
 * Closes and frees the engine. Must be called AT MOST ONCE per handle and must
 * be externally synchronized with all other engine_* calls on that handle (no
 * concurrent call may be in flight). A double close or a call on an
 * already-closed/unknown handle is a safe no-op (the handle is validated
 * against an internal live-handle registry).
 */
void engine_close(engine_handle_t engine);

#ifdef __cplusplus
}
#endif
