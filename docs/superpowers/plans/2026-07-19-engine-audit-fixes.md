# Engine Audit Fixes (Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix every confirmed critical (C1–C4) and should-fix (S1–S29) from `docs/superpowers/audits/2026-07-19-engine-audit-findings.md`, plus the cheap noted items, each behind a regression test written first.

**Architecture:** Fixes land bottom-up: Rust normalize → reconcile → store/engine → kv → FFI, then C++ glue, then TS, then packaging. Each task groups findings that share a file/subsystem so one test cycle covers them. The audit report is the companion spec — its per-finding **Verification** paragraphs are the authoritative mechanism descriptions with exact lines.

**Tech Stack:** Rust (rusqlite 0.32, no new runtime deps), C++ JSI TurboModule, TypeScript/jest, bash build scripts.

## Global Constraints

- **No new engine features** — tombstones, changed-keys events, scheduler remain out of scope (spec non-goals).
- **Regression test first** for every behavioral fix; mechanical/doc fixes need a verifying command instead.
- **No new Rust crate dependencies** (timestamp parsing is hand-rolled RFC-3339; hashing stays std).
- **Before each task:** read the target files in full AND the referenced findings in `docs/superpowers/audits/2026-07-19-engine-audit-findings.md`. Adapt test code below to the existing helpers in `rust/tests/` and `rust/src/*/tests` (test names and assertions are normative; setup boilerplate follows existing patterns).
- **After each task:** `cd packages/reconcile-engine/rust && cargo test` green; task 11 additionally requires `cargo clippy --all-targets` clean and `yarn test` green.
- **Commits:** plain messages, no attribution footers. One commit per task minimum.
- Paths below are relative to `packages/reconcile-engine/` unless rooted.

---

### Task 1: Normalize — timestamps, natural keys, numeric canonicalization

**Findings:** C1 (F1), C2 (F2), S1 (F3).

**Files:**
- Modify: `rust/src/normalize.rs` (value_to_string ~:46, key extraction ~:60, timestamp extraction ~:68-73)
- Test: `rust/src/normalize.rs` `#[cfg(test)]` + `rust/tests/` where an end-to-end ingest assertion fits better

**Interfaces:**
- Produces: `parse_timestamp_ms(s: &str) -> Option<i64>` (pub(crate) in normalize.rs) — accepts integer string, float string (truncated), RFC-3339 (`YYYY-MM-DDTHH:MM:SS(.fff)?(Z|±HH:MM)`); `None` otherwise. Rejection routing: a record whose configured `timestamp_field` is present but unparseable is dead-lettered with reason `"unparseable timestamp"`; a record whose natural-key value is JSON null / bool / object / array (or numeric non-integer) is dead-lettered with reason `"invalid natural key"`.

- [ ] **Step 1: Write failing tests**

```rust
#[test]
fn iso8601_timestamps_drive_lww_ordering() {
    // Two batches for the same key: fresh ISO ts ingested first, stale ISO ts second.
    // Before fix: stale batch wins (both fall back to now_ms). After: fresh value stays.
    // Use the engine API as tests/ingest_timing.rs does, timestamp_field = "updated_at",
    // values "2026-07-17T00:00:10Z" (fresh, name="new") then "2026-07-17T00:00:01Z" (stale, name="old").
    // Assert final field name == "new" and second summary counts the stale record unchanged, not updated.
}

#[test]
fn unparseable_timestamp_dead_letters_instead_of_now_fallback() {
    // timestamp_field="updated_at", value "not-a-date" -> record dead-lettered,
    // deadLetterCount == 1, entry not stored.
}

#[test]
fn parse_timestamp_ms_accepts_int_float_rfc3339() {
    assert_eq!(parse_timestamp_ms("1721000000000"), Some(1721000000000));
    assert_eq!(parse_timestamp_ms("1721000000000.75"), Some(1721000000000));
    assert_eq!(parse_timestamp_ms("2026-07-17T00:00:00Z"), Some(1784332800000));
    assert_eq!(parse_timestamp_ms("2026-07-17T00:00:00.5+00:00"), Some(1784332800500));
    assert_eq!(parse_timestamp_ms("2026-07-17T10:00:00+10:00"), Some(1784332800000));
    assert_eq!(parse_timestamp_ms("not-a-date"), None);
    assert_eq!(parse_timestamp_ms(""), None);
}

#[test]
fn null_natural_key_dead_letters() {
    // JSON payload [{"email":null,"name":"A"},{"email":null,"name":"B"}] with natural_key_field "email"
    // -> 0 inserted, 2 dead-lettered; no row with natural_key "null" exists.
}

#[test]
fn integer_and_string_keys_do_not_collide_after_explicit_coercion() {
    // key 1 (int) and "1" (string) still map to "1" — document the rule — but 1.0 (float) dead-letters
    // instead of creating a separate "1.0" row.
}

#[test]
fn numeric_values_canonicalize_across_formats() {
    // Ingest {"balance": 1000.0} then {"balance": "1000"} (other source, same key/ts config):
    // second ingest reports unchanged (no flip-flop), stored value is "1000".
}
```

- [ ] **Step 2: Run to verify the behavioral tests fail** — `cargo test iso8601 unparseable null_natural numeric_values` → FAIL (current fallback/coercion behavior).

- [ ] **Step 3: Implement**

In `normalize.rs`:
1. Add `parse_timestamp_ms`: try `s.parse::<i64>()`; else `s.parse::<f64>()` (must be finite, |v| < 2^53) truncated; else hand-rolled RFC-3339: split date/time on `T`, parse date `YYYY-MM-DD`, time `HH:MM:SS[.frac]`, offset `Z|±HH:MM`; convert via days-from-civil algorithm to epoch ms minus offset. ~40 lines, no deps.
2. Timestamp extraction: if `timestamp_field` configured and the field is **present**, `parse_timestamp_ms` or dead-letter (`"unparseable timestamp"`). `now_ms` only when field is None or absent from the record.
3. Natural key: match on the JSON value — `String(s)` (non-empty) → s; integer number → canonical integer string; everything else (null, bool, float, object, array, empty string) → dead-letter (`"invalid natural key"`). CSV keys are strings already; empty string still dead-letters.
4. `value_to_string` for field values: if `Number` and integral within ±2^53, format without fraction (`1000.0` → `"1000"`); non-integral floats use `{}` Display (unchanged); this canonicalizes S1's flip-flop pairs.

- [ ] **Step 4: `cargo test`** → all green, including existing suites (ingest_timing.rs now exercises real ISO ordering — update its expectations if it asserted the buggy behavior).

- [ ] **Step 5: Commit** — `fix(normalize): parse real timestamps, reject invalid natural keys, canonicalize numerics`

---

### Task 2: Normalize CSV — faithful dead-letter fragments, duplicate headers

**Findings:** S3 (F5), noted F10.

**Files:**
- Modify: `rust/src/normalize.rs` (CSV parser ~:120-181)
- Test: same file `#[cfg(test)]`

**Interfaces:**
- Produces: CSV dead-letter fragments contain the **original raw line bytes**; duplicate header names fail the whole batch with `EngineError::Command("duplicate CSV header: <name>")`.

- [ ] **Step 1: Failing tests** — (a) reject row `a@x.com,"likes, commas",extra` (column-count mismatch) and assert the dead-letter fragment is byte-identical to the original line including quotes; (b) header `email,name,name` → ingest returns code-4 error naming `name`, nothing stored.
- [ ] **Step 2: Run** → FAIL (fragment is re-joined dequoted; dup headers silently collapse).
- [ ] **Step 3: Implement** — track each row's byte span (start offset at record start, end before the row terminator) while parsing; on reject, slice the original input for the fragment. Before parsing rows, scan header for duplicates → error. Duplicate-header batch failure is preferable to per-row guessing because the wrong column could drive keying (finding F10).
- [ ] **Step 4: `cargo test`** → green.
- [ ] **Step 5: Commit** — `fix(normalize): preserve raw CSV dead-letter fragments, reject duplicate headers`

---

### Task 3: Reconcile — tie-break, short-circuit guard, dead-letter cap

**Findings:** S2 (F4), S5 (F7), noted F8, S13 (F20), noted F11.

**Files:**
- Modify: `rust/src/reconcile.rs` (wins logic ~:209-215, short-circuit ~:189-191, dead-letter insert ~:406-412), `rust/src/dispatch.rs` (new command)
- Test: `rust/src/reconcile.rs` tests + dispatch tests

**Interfaces:**
- Produces: same-source exact ties (equal ts AND equal priority) resolve to the **incoming** record (batch-order LWW); cross-source exact ties keep existing (stable). Short-circuit additionally compares stored field-name count before skipping. New commands: `deadLetterClear [source_id?]` → deleted count; dead_letter capped at 1000 rows per source (oldest pruned inside the reconcile transaction). `registerSource` rejects collection names containing `:` (and empty names) with `EngineError::Command("invalid collection name")` — fixes the `entry:{collection}:{key}` namespace ambiguity (S5/F7). Normalize rejects source fields named `_updated_at` to dead-letter (`"reserved field name"`) so hgetall's injected metadata can never shadow real data (F11).

- [ ] **Step 1: Failing tests** — (a) one batch, same key twice, `timestamp_field: None`, differing `name`: final value is the **second** record's (currently first); (b) cross-source equal-ts equal-priority: existing wins (regression guard for stability); (c) insert 1010 rejects for one source → `deadLetterCount` == 1000; (d) `deadLetterClear` returns 1000, count drops to 0; (e) `registerSource` with collection `"crm:people"` → code-4 error; (f) record containing field `_updated_at` → dead-lettered, not stored.
- [ ] **Step 2: Run** → (a), (c), (d), (e), (f) FAIL.
- [ ] **Step 3: Implement** — thread the record's source through to the wins comparison: `wins = rec.updated_at > m.updated_at || (rec.updated_at == m.updated_at && (cfg.priority > m.priority || (cfg.priority == m.priority && m.source_id == rec.source_id)))` (FieldMeta already tracks source; if not, add it — check store schema). Short-circuit: skip only when hash matches AND stored field count == incoming field count. Cap: after the batch's dead-letter inserts, `DELETE FROM dead_letter WHERE source_id=? AND id NOT IN (SELECT id FROM dead_letter WHERE source_id=? ORDER BY id DESC LIMIT 1000)` in the same tx. `deadLetterClear` in dispatch.rs + commands. Collection-name validation in dispatch.rs registerSource; `_updated_at` rejection in normalize.rs alongside the natural-key checks.
- [ ] **Step 4: `cargo test`** → green (existing `same_key_twice_in_one_batch_sees_earlier_merge` test expectations must flip — update it deliberately, citing F4).
- [ ] **Step 5: Commit** — `fix(reconcile): batch-order tie-break, field-count guard on skip, dead-letter cap and clear`

---

### Task 4: Ingest pipeline — config fingerprint, atomic meta, post-lock events

**Findings:** S15 (F22), S6 (F13), S7 (F14).

**Files:**
- Modify: `rust/src/engine.rs` (payload skip ~:106-131, post-commit block ~:141-150), `rust/src/reconcile.rs` (fold sync_meta hash update into the tx), `rust/src/ffi.rs` (event delivery after lock release), `rust/src/pubsub.rs` if the sink call site moves
- Test: `rust/tests/` integration + engine unit tests

**Interfaces:**
- Produces: `Engine::ingest` returns `(BatchSummary, Vec<(String, String)>)` pending events (channel, payload) — publish moves OUT of `Engine::ingest`; the FFI layer fires the sink after dropping the mutex guard. Payload-skip hash = hash(payload bytes + canonical serialization of the source's `SourceConfig`); `registerSource` clears the stored hash for that source when config differs.

- [ ] **Step 1: Failing tests** — (a) register source, ingest payload P, re-register same source_id with different `priority`, ingest byte-identical P → NOT skipped, data reconciled under new priority; (b) unit: sync_meta.content_hash row updated by the reconcile transaction itself (inspect after commit; simulate the old two-step by asserting no separate UPDATE occurs — assert via `sqlite3_changes`-style counting or by checking hash present even when a post-commit failure is injected — simplest: make ingest return Ok and correct hash when the events vec is dropped unfired); (c) events: ingest with a registered subscriber → sink fires exactly once per changed collection AFTER ingest returns (test via FFI-level harness: callback records thread/time; assert no deadlock when the callback synchronously calls `engine_execute` — this is the F14 re-entrancy regression, now safe because the lock is released).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** — pass the payload+config fingerprint into reconcile; upsert it inside the existing sync_meta upsert (reconcile.rs:414-417). Delete the standalone UPDATE (engine.rs:141-144). `Engine::ingest` collects `(channel, payload)` pairs instead of publishing; `ingest_response` (ffi.rs) drops the `MutexGuard` then invokes the sink for each pending event. registerSource: compare stored config; on change, `UPDATE sync_meta SET content_hash = NULL WHERE source_id = ?`.
- [ ] **Step 4: `cargo test`** → green.
- [ ] **Step 5: Commit** — `fix(engine): config-aware skip hash, meta update inside tx, events fire outside engine lock`

---

### Task 5: Store — atomic idempotent migration, transactional deletes, open guard

**Findings:** C3 (F12), S10 (F17), S14 (F21).

**Files:**
- Modify: `rust/src/store.rs` (migration ~:78-84, open ~:60-77), `rust/src/commands.rs` (del ~:107, purge_if_expired ~:27-32), `rust/src/ffi.rs` or `engine.rs` (open-path registry)
- Test: store/commands unit tests + a kill-window simulation test

**Interfaces:**
- Produces: migrations run per-version inside `conn.transaction()` and are idempotent (column-existence check via `pragma_table_info` before ALTER). `Engine::open` errors with `EngineError::Command("database already open: <path>")` when the canonicalized path is in the process-wide open registry (a `static Mutex<HashSet<PathBuf>>`); close removes it.

- [ ] **Step 1: Failing tests** — (a) simulate the bricked state: open a raw rusqlite connection, run only `ALTER TABLE entries ADD COLUMN content_hash TEXT` on a v1 schema, leave `user_version=1`, close; then `Store::open` → must succeed (idempotent) and end at user_version 2 — currently errors forever; (b) kill-window for del: hard to simulate mid-statement — instead assert the three DELETEs run inside one transaction by checking `conn.is_autocommit() == false` via a wrapper, or restructure so a single tx object is used and unit-test the helper; (c) second `Engine::open` on same path (first still open) → Err; after close, open succeeds.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** — migration: for v2, check `pragma_table_info('entries')` for each column; wrap ALTERs + `PRAGMA user_version = 2` in `conn.transaction()` (rusqlite tx works for these). del/purge: take `&mut` route or `execute_batch("BEGIN; ...; COMMIT;")` with bound params via three prepared statements inside an explicit `unchecked_transaction()`. Registry: `static OPEN_PATHS: OnceLock<Mutex<HashSet<PathBuf>>>`; canonicalize (fall back to the raw path if canonicalize fails on not-yet-existing file — use parent dir canonicalize + filename); insert on open, remove on close AND on open-failure cleanup.
- [ ] **Step 4: `cargo test`** → green.
- [ ] **Step 5: Commit** — `fix(store): atomic idempotent migrations, transactional deletes, double-open guard`

---

### Task 6: KV — hset TTL, error propagation, expire bounds, flusher surfacing, cache bound

**Findings:** S4 (F6), S11 (F18), S12 (F19), noted F23, noted F24.

**Files:**
- Modify: `rust/src/commands.rs`, `rust/src/engine.rs` (KvCache, flush_kv), `rust/src/ffi.rs` (flusher loop ~:78-86, close ~:409-427), `rust/src/dispatch.rs` (hset cache mirror)
- Test: commands/engine unit tests

**Interfaces:**
- Produces: `hset` preserves an existing TTL (Redis semantics). All kv reads use rusqlite `OptionalExtension::optional()` — storage errors propagate as `EngineError::Storage` (code 2), never read as "missing". `expire` uses `saturating_add` and rejects `ttl_ms <= 0` with code 4. Flusher failures set a sticky engine error surfaced by `engine_last_error` and the next command; `kv.pending` is capped at 4096 (sets fail with Storage error beyond it); `KvCache.map` capped at 8192 entries (evict arbitrary non-pending on overflow). `engine_close` reports flush/checkpoint failure via `set_last_error` and returns `false`.

- [ ] **Step 1: Failing tests** — (a) `expire(k, 60_000)` then `hset(k, f, v)` then advance clock past 60s → key IS expired (currently immortal); update/delete the locked-in `hset_after_expiry_survives` test with a comment citing F6; (b) `expire(k, i64::MAX)` → no panic/wrap, key still alive (saturated); `expire(k, 0)` and `expire(k, -5)` → code-4 error; (c) unit for `.optional()`: hard to inject I/O error — assert by type: change signatures so the closure returns `Result<_, EngineError>` and grep-assert no `.ok()`/`unwrap_or(false)` remain on kv query paths (verifying command in Step 4); (d) pending cap: enqueue 4097 sets with flushes disabled (test hook or in-memory failure injection via read-only DB file) → 4097th errors; (e) cache bound: insert 9000 distinct keys, assert `kv.map.len() <= 8192`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** per the interface block; sticky error: `engine.sticky_error: Option<EngineError>` set by flusher (through the Arc<Mutex>), taken and returned by the next command dispatch.
- [ ] **Step 4: `cargo test` green + verifying command:** `grep -n '\.ok()\|unwrap_or(false)' rust/src/commands.rs` → no hits on kv read paths (lines formerly 27, 63, 71, 216, 246).
- [ ] **Step 5: Commit** — `fix(kv): Redis-correct hset TTL, storage errors propagate, bounded queues and cache`

---

### Task 7: FFI hardening — panic containment, poison recovery, close guard

**Findings:** S16 (F25), S9 (F16), S8 (F15), noted F27, F28, F29, F30; clippy baseline errors.

**Files:**
- Modify: `rust/src/ffi.rs` (all 14 extern fns), `rust/src/binenc.rs` (length guards), `cpp/include/engine.h` (contract docs)
- Test: `rust/tests/ffi_hardening.rs` (new)

**Interfaces:**
- Produces: every extern "C" fn body wrapped in `std::panic::catch_unwind(AssertUnwindSafe(..))` via a local macro `ffi_guard!` — on panic: `set_last_error(500, "internal panic")`, return error envelope / null / false per signature. All `lock().unwrap()` become `lock().unwrap_or_else(std::sync::PoisonError::into_inner)`. `engine_close` validates the handle against the same open-path registry semantics (Task 5) — a close of an unknown/already-closed handle returns `false` without touching memory (registry of live handle addresses: `static LIVE_HANDLES: Mutex<HashSet<usize>>`, inserted on open, removed at close entry). `*out_len = 0` written immediately after null-checks in all three query fns. `serde_json::to_value(&summary).unwrap()` replaced with a match returning an ok:false envelope. engine.h documents: engine_close exclusivity + at-most-once, (ptr,len) validity requirements for engine_ingest_bytes. Mark pointer-taking extern fns `unsafe extern "C"` to satisfy clippy `not_unsafe_ptr_arg_deref` (ABI-identical; header unchanged). binenc.rs (F27): guard every `len as u32` with `len <= u32::MAX as usize && (len as u32) < SCHEMA_FIELD_MISSING` — on violation return an encode error that the query path converts to `set_last_error` + null (unit test with a synthetic oversized-length path via a cfg(test) constructor, since real 4 GiB strings are unbuildable).

- [ ] **Step 1: Failing tests** — (a) inject a panic (test-only command or a `#[cfg(test)]` panic hook in dispatch, e.g. cmd "\_\_test_panic") through `engine_execute` → returns error envelope code 500, process alive; (b) after that panic, a subsequent `engine_kv_get` works (no poison abort); (c) `engine_close(handle)` twice → second returns false, no crash (run under the test harness; on the old code this is a double-free — the test only becomes runnable after the fix, so write it, expect UB/crash risk, and gate it behind the fix commit; note this in the test comment); (d) `engine_query_entries_bin` with an invalid arg → returns null AND out_len == 0 when caller pre-set it to 0xFFFF.
- [ ] **Step 2: Run (a),(b),(d)** → FAIL/abort.
- [ ] **Step 3: Implement** per interface block.
- [ ] **Step 4: `cargo test` green; `cargo clippy --all-targets` → zero errors** (the 19 baseline errors were all this class).
- [ ] **Step 5: Commit** — `fix(ffi): panic containment, poison recovery, close guard, clippy clean`

---

### Task 8: C++ glue — open contract, error envelopes, kvGet fidelity

**Findings:** S20 (F37), S21 (F38), S22 (F39), S23 (F40), noted F41, F31, F32.

**Files:**
- Modify: `cpp/NativeReconcileEngine.cpp`, `cpp/NativeReconcileEngine.h`, `rust/src/ffi.rs` + `cpp/include/engine.h` (one new out-param for kv_get)
- Test: no C++ test harness exists — verification is (a) Rust-side tests for the new `engine_kv_get_v2`, (b) compile via `yarn expo run:ios`/`run:android` in Task 11, (c) jest tests in Task 9 for the TS-visible behavior.

**Interfaces:**
- Produces: `open(path)` when already open with a **different** path throws `jsi::JSError("engine already open at <old>; close first")`; same path stays a no-op. Open failures parse last_error JSON and throw with message `EngineError:<code>:<message>` (TS unwraps this — Task 9 consumes the format). execute/ingestDirect "engine not open" rejections become the canonical envelope string `{"ok":false,"code":4,"message":"engine not open"}` resolved (not rejected) so unwrap() throws EngineError. New FFI: `char* engine_kv_get2(handle, key, int* out_err)` — out_err=0 miss, 1 error (last_error set); C++ kvGet uses it, throws JSError on error. Numeric args validated with `std::isfinite` + clamp to [0, 2^53] before `static_cast`. `readU32` gains explicit little-endian byte assembly, and the decoder's bounds checks are rewritten in subtraction form (`klen > len - off`) as hygiene (refuted-F26's recommendation). Event ctx becomes a heap `std::weak_ptr<NativeReconcileEngine>*` freed by a final `engine_set_event_callback(handle, nullptr, nullptr)` before close.

- [ ] **Step 1: Rust test for `engine_kv_get2`** (miss vs error distinction, err flag set) → FAIL (fn absent).
- [ ] **Step 2: Implement Rust side** (`engine_kv_get2` alongside deprecated `engine_kv_get`), header updated, `cargo test` green.
- [ ] **Step 3: Implement all C++ changes** per interface block.
- [ ] **Step 4: Verify compilation** — `cd apps/sandbox && yarn expo prebuild --no-install 2>/dev/null; xcodebuild -workspace ... ` is heavyweight: minimum bar here is `clang++ -fsyntax-only` with the RN header paths if feasible, otherwise defer compile proof to Task 11's device build and note it.
- [ ] **Step 5: Commit** — `fix(cpp): honest open contract, enveloped errors, kvGet error fidelity, hardened casts`

---

### Task 9: TS surface — glob parity, subscription safety, docs, tests

**Findings:** S17 (F33), S18 (F34), S19 (F35), S24 (F44), noted F36, F42, F43, F45.

**Files:**
- Modify: `src/index.ts`, `apps/sandbox/src/screens/EntriesScreen.tsx`
- Test: `src/__tests__/index.test.ts` (+ new `src/__tests__/glob.test.ts`)

**Interfaces:**
- Produces: `globMatch(pattern: string, text: string): boolean` exported from `src/glob.ts` — a direct TS port of Rust `glob.rs`'s two-pointer matcher (replaces globToRegex). `subscribe` handler invocations wrapped in try/catch routing to optional `onError` third parameter `(err: unknown) => void` (default: `console.error`); payload parsed once with its own guard. The unsubscribe closure is idempotent and attaches `.catch(() => {})`. `openEngine` throws `EngineError` when the native message matches `EngineError:<code>:<message>` (Task 8's format). TSDoc added: `executeRawSync` (JS-thread blocking warning mirrored from the C++ header), `openEngine` (synchronous under the hood), `redis.expire/ttl` (milliseconds; null means missing-or-no-TTL; expire on missing key throws code 4).

- [ ] **Step 1: Failing tests** — glob vector table mirrored from `rust/src/glob.rs` tests plus `["changes:*", "changes:foo\nbar", true]`; overlapping subscriptions where one handler throws → sibling still invoked, onError called; non-JSON payload → onError, no unhandled throw; unsubscribe after `closeEngine` → no unhandled rejection (assert via `process.on('unhandledRejection')` trap in the test); double-call unsubscribe → native unsubscribe sent once; EntriesScreen: unmount before subscribe resolves → returned unsub invoked on resolution (extract the effect body into a testable `subscribeWithCleanup` helper in `src/index.ts` and use it in the screen).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** per interface block.
- [ ] **Step 4: `yarn test`** → green.
- [ ] **Step 5: Commit** — `fix(ts): glob parity port, safe subscriptions, honest docs, EntriesScreen cleanup race`

---

### Task 10: Packaging — bootstrap, drift guards, toolchain, ABIs

**Findings:** C4 (F46), S25 (F47), S26 (F48), S27 (F49), S28 (F50), S29 (F51), noted F52–F56.

**Files:**
- Create: `packages/reconcile-engine/README.md`, `rust/rust-toolchain.toml`, `scripts/check-artifacts.sh`
- Modify: `scripts/build-ios.sh`, `scripts/build-android.sh`, `rust/Cargo.toml`, `package.json`, `ReconcileEngine.podspec`, `apps/sandbox/ios/Podfile`, `apps/sandbox/android/app/src/main/jni/CMakeLists.txt`

**Decisions locked in:** binaries stay **untracked** (no git-lfs); the fix is fail-fast + docs + drift manifest. S29's full `android/` gradle-library project is out of scope (feature-scale); the consumer contract is documented instead.

- [ ] **Step 1: Write `scripts/check-artifacts.sh`** — fails with actionable message when `ios-rust/`/`android-rust/` are missing ("run scripts/build-ios.sh / build-android.sh; needs rustup targets X, cargo-ndk, NDK"); verifies `artifacts-manifest.json` (written by both build scripts: rust/ tree content hash via `git hash-object` over sorted `git ls-files rust/src rust/Cargo.*` + rustc version + sha256 of each artifact) matches a fresh recomputation of the rust-tree hash; verifies `nm` symbol list of the android .a equals the `engine_*` declarations grep'd from `cpp/include/engine.h`.
- [ ] **Step 2: Wire it** — podspec `prepare_command` runs it for iOS; CMakeLists.txt runs it via `execute_process` before `IMPORTED_LOCATION`; both fail the build loudly instead of undefined-symbol link errors.
- [ ] **Step 3: Build scripts** — build-android.sh: preflight `command -v cargo-ndk` + `rustup target list --installed` check for all four Android targets, add `-t armeabi-v7a -t x86` and `--platform 24`, build first THEN replace `$OUT` (fix F53 ordering), write manifest. build-ios.sh: add `x86_64-apple-ios` sim build + `lipo -create` fat sim slice, same preflight + manifest. `rust-toolchain.toml`: pin stable channel + list all six targets; `rust-version` in Cargo.toml.
- [ ] **Step 4: package.json** — add `"private": true`; add `codegenConfig.android.javaPackageName": "com.rnexperiments.reconcileengine"`.
- [ ] **Step 5: Podfile** — resolve the spec path via `node --print "require.resolve('@rn-experiments/reconcile-engine/package.json')"` and **append** to `input_paths`; warn when no phase matches. CMakeLists: derive `PKG` the same way via `execute_process(COMMAND node --print ...)` with the old relative path as fallback.
- [ ] **Step 6: README.md** — bootstrap (toolchain installs, build scripts), the four Android consumer-integration pieces (CMake, OnLoad.cpp, app-level codegen task, ABI restriction — content from finding F51's verification paragraph), platform support matrix (no armeabi-v7a→now supported, no Catalyst, Intel-sim now supported), OnLoad.cpp divergence-check note (`diff` command against the RN default-app-setup copy, from F56).
- [ ] **Step 7: Rebuild both platforms** — run both build scripts; verify `scripts/check-artifacts.sh` passes; `lipo -info` shows fat sim slice; `ls android-rust` shows four ABIs.
- [ ] **Step 8: Commit** — `fix(packaging): fail-fast artifact checks, drift manifest, pinned toolchain, full ABI coverage`

---

### Task 11: Full verification + report annotation

**Files:**
- Modify: `docs/superpowers/audits/2026-07-19-engine-audit-findings.md` (status column), `docs/INTEGRATIONS.md` (hset TTL semantics note, timestamp format guidance update: ISO-8601 now supported)

- [ ] **Step 1:** `cd packages/reconcile-engine/rust && cargo test && cargo clippy --all-targets` → green, zero clippy errors.
- [ ] **Step 2:** `cd packages/reconcile-engine && yarn test` → green.
- [ ] **Step 3:** Rebuild native artifacts (both scripts) and build the sandbox app for at least iOS simulator (`yarn expo run:ios` or xcodebuild) to prove the C++ changes compile; Android emulator build if the environment allows.
- [ ] **Step 4:** Annotate every C/S finding in the audit report with `**Status:** fixed in <commit>` (or `deferred` for the documented-instead items: S29 android project, glob '?'/classes, Catalyst); update INTEGRATIONS.md where behavior changed (timestamps, hset TTL, deadLetterClear, subscribe onError).
- [ ] **Step 5:** Commit — `docs: mark audit findings fixed, update integration guidance`
