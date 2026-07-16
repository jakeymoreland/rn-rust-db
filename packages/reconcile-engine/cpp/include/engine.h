#pragma once
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

/* Binary rows: LE [u32 count]([u32 klen][key][u32 jlen][fields-json])*. Free with engine_free_bytes. */
unsigned char* engine_query_entries_bin(engine_handle_t engine, const char* collection, size_t* out_len);

/*
 * Schema-packed binary rows: LE [u32 nFields]([u32 len][name])* [u32 count]
 * then per row [u32 klen][key] and one [u32 vlen][value] per field in table
 * order (vlen = 0xFFFFFFFF marks a missing/null field). fields_csv is a
 * comma-separated field list. Free with engine_free_bytes.
 */
unsigned char* engine_query_entries_schema_bin(engine_handle_t engine, const char* collection, const char* fields_csv, size_t* out_len);

/* Windowed variant of engine_query_entries_schema_bin: rows [offset, offset+limit) ordered by natural_key. limit must be > 0, offset >= 0. */
unsigned char* engine_query_entries_schema_bin_range(engine_handle_t engine, const char* collection, const char* fields_csv, long long limit, long long offset, size_t* out_len);

/*
 * Registers cb to be invoked once per matching pubsub event. cb fires
 * SYNCHRONOUSLY, on whatever thread triggered the event, while the engine's
 * internal mutex is held for that call. The mutex is NOT reentrant: calling
 * ANY engine_* function (engine_execute, engine_query_entries_bin,
 * engine_set_event_callback, etc.) from inside cb, on the same thread, will
 * deadlock against the very lock cb is running under. Copy the channel and
 * payload strings out (they are only valid for the duration of the call) and
 * return immediately; do any further engine calls after cb returns, or hand
 * the work off to another thread.
 */
void engine_set_event_callback(engine_handle_t engine, void* ctx, engine_event_cb cb);

void engine_free_string(char* s);

/* len must be exactly the value written to out_len by the call that produced p (e.g. engine_query_entries_bin). Any other value is undefined behavior. */
void engine_free_bytes(unsigned char* p, size_t len);
void engine_close(engine_handle_t engine);

#ifdef __cplusplus
}
#endif
