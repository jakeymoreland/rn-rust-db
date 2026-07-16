#pragma once
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef void* engine_handle_t;
typedef void (*engine_event_cb)(void* ctx, const char* channel, const char* payload_json);

/* Returns NULL on failure; see engine_last_error(). */
engine_handle_t engine_open(const char* path);

/* Thread-local error as {"code":n,"message":"..."} JSON, or NULL. Free with engine_free_string. */
char* engine_last_error(void);

/* Executes a {"cmd":...,"args":[...]} request; returns response JSON. Free with engine_free_string. */
char* engine_execute(engine_handle_t engine, const char* request_json);

/* Binary rows: LE [u32 count]([u32 klen][key][u32 jlen][fields-json])*. Free with engine_free_bytes. */
unsigned char* engine_query_entries_bin(engine_handle_t engine, const char* collection, size_t* out_len);

/* cb may be called from any thread holding the engine lock; keep it fast, copy strings out. */
void engine_set_event_callback(engine_handle_t engine, void* ctx, engine_event_cb cb);

void engine_free_string(char* s);
void engine_free_bytes(unsigned char* p, size_t len);
void engine_close(engine_handle_t engine);

#ifdef __cplusplus
}
#endif
