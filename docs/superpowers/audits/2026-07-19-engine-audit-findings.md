# Reconcile-Engine Audit Findings — 2026-07-19

> **Fix status (2026-07-19, branch `audit-fixes`).** All 4 criticals and all 29
> should-fixes are **fixed**, each behind a regression test written first. The
> cheap noted items (F8, F10, F11, F23, F24, F27, F28, F29, F30, F31, F41, F52,
> F54, F55, F56) are fixed too. **Deferred (documented instead):** F32 event-ctx
> weak_ptr shim (currently sound; `close()` now detaches the callback first as
> partial hardening), S29 Android gradle-library project, Mac Catalyst support,
> and full Redis glob `?`/`[...]` classes. F26 was **refuted** during
> verification. Fixes span commits `e88c5b6`…`051e611`. Verified end to end:
> 91 Rust lib + 8 integration tests, 30 jest tests, `cargo clippy` zero errors
> (was 19), all 7 native targets cross-compile, `pod install` hooks succeed, and
> the sandbox app builds (NativeReconcileEngine.cpp compiles clean against
> codegen headers).


Scope: full audit per `docs/superpowers/specs/2026-07-19-engine-audit-and-real-db-rig-design.md` (Phase 1).
Method: 5 specialist passes (merge correctness, durability/lifecycle, FFI soundness, JSI/TS API, packaging) -> cross-pass dedupe (60 raw -> 56 unique) -> independent adversarial verification of every finding (refute-first stance, grouped by file).
Baseline: `cargo test` passes (4 suites), `cargo clippy` FAILS with 19 errors incl. `not_unsafe_ptr_arg_deref` on public FFI fns, `yarn test` passes 6/6.
Result: **4 critical, 29 should-fix, 22 noted, 1 refuted.** Verifiers re-graded three findings (F25 critical->should-fix: no reachable panic today, containment gap only; F22 noted->should-fix: silent data omission on config change; F26 should-fix->refuted-path).

## Critical (fix before rig)

### C1. Unparseable timestamp_field values silently fall back to ingest-time now_ms… — `packages/reconcile-engine/rust/src/normalize.rs:72` [CONFIRMED]

**Finding (F1):** Unparseable timestamp_field values silently fall back to ingest-time now_ms, corrupting merge ordering

**Failure:** cfg.timestamp_field="updated_at" with ISO-8601 values (exactly what tests/ingest_timing.rs sends: "2026-07-17T00:00:00Z") — parse::<i64>() fails for every record, so updated_at becomes now_ms. A stale backup batch ingested after a fresh API batch gets a larger now_ms and overwrites newer field values; same for float timestamps like 1721000000000.0 (stringified as "1721000000000.0"). No error, no dead-letter — LWW ordering is silently replaced by ingest order.

**Verification:** normalize.rs:68-73 does parse::<i64>().ok().unwrap_or(now_ms): any non-integer-string timestamp (ISO-8601, float-formatted numbers) silently falls back to ingest-time now_ms from the engine clock (engine.rs:134). tests/ingest_timing.rs:25,37 confirms the exact scenario: timestamp_field="updated_at" with ISO values, so every record's updated_at is now_ms. reconcile.rs:212-213 uses rec.updated_at for per-field wins, so LWW silently degrades to ingest order and a stale batch ingested later overwrites newer values with no error or dead-letter.

**Fix sketch:** On parse failure dead-letter the record (or support ISO-8601/float parsing); only use now_ms when timestamp_field is None or the field is absent.

### C2. JSON null natural key coerces to the string "null" and passes the empty-key… — `packages/reconcile-engine/rust/src/normalize.rs:60` [CONFIRMED]

**Finding (F2):** JSON null natural key coerces to the string "null" and passes the empty-key guard, merging unrelated records into one row

**Failure:** Payload [{"email":null,"name":"A"},{"email":null,"name":"B"}]: value_to_string(Null) yields "null" (non-empty), so both records get natural_key="null" and merge into a single 'people:null' row instead of being dead-lettered; every null-key record from every batch piles into that row. Related coercion: numeric key 1 and string key "1" collide, while 1.0 becomes a separate "1.0" row.

**Verification:** value_to_string (normalize.rs:46-51) maps Value::Null through the catch-all Display arm to the 4-char string "null", which passes the Some(k) if !k.is_empty() guard at line 60. All null-key records therefore share natural_key="null" and reconcile.rs:337-346 groups and merges them into a single row instead of dead-lettering. The 1 vs "1" collision and 1.0 -> "1.0" split follow from the same conversion.

**Fix sketch:** In normalize_json treat Value::Null (and arguably non-string/non-integer keys) for the natural-key field as missing -> reject to dead_letter; make key coercion rules explicit.

### C3. v1->v2 migration is neither atomic nor idempotent — `packages/reconcile-engine/rust/src/store.rs:83` [CONFIRMED]

**Finding (F12):** v1->v2 migration is neither atomic nor idempotent: execute_batch runs two ALTER TABLEs and the user_version bump as separate autocommit statements, and ALTER ADD COLUMN is not re-runnable.

**Failure:** Process is killed after 'ALTER TABLE entries ADD COLUMN content_hash' commits but before 'PRAGMA user_version = 2'. On next launch user_version is still 1, the migration re-runs, the first ALTER fails with 'duplicate column name: content_hash', and Store::open returns Err forever — the database is permanently unopenable without manual surgery.

**Verification:** Verified against rusqlite 0.32.1 source: execute_batch loops prepare/step per statement with NO transaction wrapping, so store.rs:83's SCHEMA_V2_MIGRATION runs three ALTER TABLEs and PRAGMA user_version=2 as four separate autocommit statements. Demonstrated the failure state with sqlite3 CLI: a DB with content_hash already added but user_version=1 fails the re-run with 'duplicate column name: content_hash', leaving user_version at 1 — Store::open (store.rs:78-84) then errors on every subsequent open, permanently. ALTER ADD COLUMN is not idempotent and PRAGMA user_version would participate in a transaction if one were used (the fix works). Exposure is wider than claimed: every FRESH database also traverses this window (version==0 runs SCHEMA_V1 then the migration batch in the same open, store.rs:79-84), and any mid-batch error (disk full, SQLITE_BUSY from a second connection) bricks the DB without needing a kill.

**Fix sketch:** Wrap the migration in an explicit transaction (BEGIN; ALTER...; ALTER...; ALTER...; PRAGMA user_version=2; COMMIT via conn.transaction()/execute_batch with BEGIN/COMMIT), and/or make it idempotent by checking pragma_table_info('entries') for the columns before ALTERing.

### C4. The prebuilt Rust binaries are NOT actually committed — `.gitignore:13` [CONFIRMED]

**Finding (F46):** The prebuilt Rust binaries are NOT actually committed: .gitignore lines 10, 13-14 (*.xcframework, packages/reconcile-engine/ios-rust/, packages/reconcile-engine/android-rust/) exclude both the ReconcileEngine.xcframework (including its Info.plist and Headers) and android-rust/*/libreconcile_engine.a. git ls-files confirms zero .a/xcframework files are tracked. The podspec's vendored_frameworks = "ios-rust/ReconcileEngine.xcframework" and the sandbox CMake IMPORTED_LOCATION ${PKG}/android-rust/${ANDROID_ABI}/libreconcile_engine.a both point at gitignored paths.

**Failure:** Clean clone: pod install emits a missing-vendored-framework warning (or errors), and the iOS app fails at link with undefined _engine_* symbols; Android fails in ninja with 'missing and no known rule to make ../packages/reconcile-engine/android-rust/arm64-v8a/libreconcile_engine.a'. Nothing in the repo (no README in the package, no postinstall) tells the consumer they must first install rustup targets + cargo-ndk + NDK and run scripts/build-ios.sh and scripts/build-android.sh.

**Verification:** Verified with git: git ls-files tracks zero .a/.xcframework/.so files (only PNG app icons match the pattern), and git check-ignore -v attributes the artifacts to .gitignore:13 (packages/reconcile-engine/ios-rust/) and :14 (packages/reconcile-engine/android-rust/); line 10 (*.xcframework) also matches. ReconcileEngine.podspec:16 vendors ios-rust/ReconcileEngine.xcframework and apps/sandbox jni/CMakeLists.txt:24 sets IMPORTED_LOCATION to ${PKG}/android-rust/${ANDROID_ABI}/libreconcile_engine.a — both gitignored paths. The package has no README and no pre/postinstall hooks to tell a clean-clone consumer to run the build scripts. Native builds from a fresh clone cannot link.

**Fix sketch:** Either commit the artifacts (git-lfs given ~21-29 MB per slice) or un-gitignore and add a documented bootstrap step; minimally add a README/preinstall check in packages/reconcile-engine that fails fast with 'run scripts/build-ios.sh / build-android.sh' when ios-rust/ or android-rust/ is absent.


## Should-fix

### S1. Number-to-string conversion is format-sensitive, so numerically equal values… — `packages/reconcile-engine/rust/src/normalize.rs:49` [CONFIRMED]

**Finding (F3):** Number-to-string conversion is format-sensitive, so numerically equal values from different sources never converge

**Failure:** JSON source sends balance:1000.0 -> stored "1000.0"; CSV source (or JSON int 1000) sends "1000". fields differ and fields_hash differs, so every alternate ingest flips the field, counts as updated, and publishes a change event forever — near-identical batches never reach the unchanged/no-op state; also 1e20-scale floats serialize in exponent notation, mismatching decimal forms.

**Verification:** normalize.rs:49 uses serde_json Display: float 1000.0 -> "1000.0", int/CSV -> "1000". In reconcile.rs the differing strings defeat the content-hash short-circuit (line 191, fields_hash over the string map) and trigger fields.insert + dirty at lines 218-221, so each winning ingest counts as updated, sets visibly_changed, and publishes a changes event; numerically-equal values from differently-formatted sources flip forever and never reach the unchanged no-op state.

**Fix sketch:** Canonicalize numeric values during normalization (e.g. integral floats -> integer form, one canonical float formatting) or keep typed values instead of strings.

### S2. Exact tie (equal timestamp AND equal priority) always loses, so within one… — `packages/reconcile-engine/rust/src/reconcile.rs:213` [CONFIRMED]

**Finding (F4):** Exact tie (equal timestamp AND equal priority) always loses, so within one batch the FIRST duplicate wins instead of last-writer-wins

**Failure:** timestamp_field=None (as in reconcile.rs's own test configs): every record in a batch gets updated_at=now_ms. A JSON export containing the same key twice — original row plus a later correction row — merges to the FIRST row's values: for the second record rec.updated_at == m.updated_at and cfg.priority == m.priority, so wins=false and the correction is silently discarded, violating the spec's last-writer-wins.

**Verification:** Traced exactly. With timestamp_field=None, normalize.rs build_record (lines 68-73) stamps every record in a batch with the same now_ms. In reconcile.rs merge_group, the first duplicate establishes FieldMeta{updated_at: now_ms, priority: cfg.priority}; the second duplicate evaluates wins (lines 209-215): rec.updated_at > m.updated_at is false (equal) and rec.updated_at == m.updated_at && cfg.priority > m.priority is false (same cfg, equal priority), so wins=false and the later record's differing value is silently discarded as 'unchanged'. No same-source or batch-sequence tiebreaker exists anywhere in the file. The existing test same_key_twice_in_one_batch_sees_earlier_merge (lines 552-577) only covers distinct timestamps (100 vs 200), so the tie case is untested and cargo test passing does not refute it.

**Fix sketch:** Break full ties in favor of the incoming record when it is from the same source (or use batch sequence number as a final tiebreaker).

### S3. CSV dead-letter fragment is rebuilt with row.join(","), destroying quoting and… — `packages/reconcile-engine/rust/src/normalize.rs:169` [CONFIRMED]

**Finding (F5):** CSV dead-letter fragment is rebuilt with row.join(","), destroying quoting and making the quarantined row unreplayable

**Failure:** Row 'a@x.com,"likes, commas",extra' rejected for column-count mismatch is stored in dead_letter as 'a@x.com,likes, commas,extra' — the embedded comma is now a field separator, so the preserved fragment misrepresents the original data and cannot be corrected/re-ingested faithfully (newlines and quotes inside fields are likewise lost).

**Verification:** normalize.rs:169 builds the reject fragment as row.join(",") from fields the parser has already dequoted (quote handling at lines 125-137 strips RFC-4180 quoting), and reconcile.rs:406-410 stores that fragment verbatim in dead_letter. A quoted field containing a comma/quote/newline is stored with its structure destroyed, so the quarantined row misrepresents the original bytes and cannot be faithfully re-ingested.

**Fix sketch:** Preserve the original raw line (track byte offsets while parsing) or re-quote fields per RFC 4180 when building the fragment.

### S4. hset clears the key's TTL on every field write, contradicting real Redis… — `packages/reconcile-engine/rust/src/commands.rs:125` [CONFIRMED]

**Finding (F6):** hset clears the key's TTL on every field write, contradicting real Redis semantics the comment claims to follow

**Failure:** A derived-value cache hash gets expire(key, 60s); any subsequent hset refreshing one field deletes the key_ttl row, making the whole key immortal — in Redis, HSET on an existing key preserves its TTL (only full-key replacement like SET clears it). Cache entries that should expire silently persist forever; test hset_after_expiry_survives has locked in the divergent behavior.

**Verification:** commands.rs:124-125: hset unconditionally executes 'DELETE FROM key_ttl WHERE key = ?1' after every field upsert, and dispatch.rs:56-57 mirrors it by removing the cache TTL entry. Real Redis HSET preserves an existing TTL (only whole-key replacement like SET clears it), so the comment 'Redis SET semantics' misapplies SET behavior to HSET. Consequence traced: expire(key) then any hset makes the key immortal. Test hset_after_expiry_survives (commands.rs:410-419) depends on this divergence — so the behavior is locked in by the suite.

**Fix sketch:** Remove the DELETE FROM key_ttl in hset (match Redis), or rename/document the divergence explicitly.

### S5. entry:{collection}:{key} namespace is ambiguous when collection names contain ':' — `packages/reconcile-engine/rust/src/commands.rs:142` [CONFIRMED]

**Finding (F7):** entry:{collection}:{key} namespace is ambiguous when collection names contain ':'

**Failure:** SourceConfig.collection="crm:people" is accepted; scan emits "entry:crm:people:a@x.com", but hgetall's split_once(':') parses collection="crm", natural_key="people:a@x.com" and returns an empty map — every key scan returns for that collection is unreadable, and can shadow-collide with a real collection "crm" whose keys start with "people:".

**Verification:** No layer validates collection names: dispatch.rs:92-96 registerSource just deserializes SourceConfig and inserts, normalize.rs copies cfg.collection verbatim into records, and TS index.ts:68-69 passes cfg through unmodified. The only split is commands.rs:142 hgetall's split_once(':'), which for collection "crm:people" (key "entry:crm:people:a@x.com" as emitted by scan at commands.rs:191) parses collection="crm", natural_key="people:a@x.com" and returns an empty map — or the wrong row if a real collection "crm" has a natural key starting "people:". Exact failure path traceable end to end; no guard exists.

**Fix sketch:** Reject ':' in collection names at source registration (or escape the separator in virtual keys).

### S6. sync_meta.content_hash update and pubsub publish happen outside (after) the… — `packages/reconcile-engine/rust/src/engine.rs:141` [CONFIRMED]

**Finding (F13):** sync_meta.content_hash update and pubsub publish happen outside (after) the reconcile transaction; a failure or kill in that window returns an error / loses events for a batch that actually committed.

**Failure:** reconcile() commits the batch, then the standalone 'UPDATE sync_meta SET content_hash' fails (disk I/O error, SQLITE_BUSY from a second connection). ingest() returns Err although rows are durably committed, and publish never runs. On retry, reconcile re-runs but every record is now 'unchanged', collections is empty, so no changes:* event is ever emitted — subscribers permanently miss the change. A process kill between commit and publish loses the events the same way.

**Verification:** Exact path traced: reconcile() commits at reconcile.rs:422; the content_hash UPDATE (engine.rs:141-144) and pubsub publish (engine.rs:145-150) run after, outside any transaction. If the UPDATE fails, ingest() returns Err although the batch is durably committed, and publish never runs. On retry the stale stored hash mismatches so the skip does not fire, reconcile re-runs, every record merges as unchanged, visibly_changed stays false, summary.collections is empty, so no changes:* event is ever published — live subscribers permanently miss a committed change. The kill-between-commit-and-publish variant is weaker (subscribers are in-process and die too), but the error-return-despite-commit path stands on its own.

**Fix sketch:** Write content_hash inside the reconcile transaction (pass it into reconcile and fold it into the existing sync_meta upsert), and derive publish from the committed summary; if a post-commit step can still fail, return Ok with the summary rather than Err, or persist an outbox row in the same tx and drain it to pubsub.

### S7. pubsub sink callback is invoked synchronously while the engine mutex is held… — `packages/reconcile-engine/rust/src/engine.rs:148` [CONFIRMED]

**Finding (F14):** pubsub sink callback is invoked synchronously while the engine mutex is held (ingest runs under the FFI Arc<Mutex<Engine>>), so any re-entrant engine call from the event callback self-deadlocks.

**Failure:** A subscriber's natural reaction to a 'changes:people' event is to read the new data. If the C callback (engine_set_event_callback) synchronously calls engine_execute/engine_query_entries_bin on the same thread, ffi.inner.lock() is re-acquired on a non-reentrant std Mutex — deadlock (undefined behavior per std docs). The callback also blocks the flusher thread and all other FFI calls for its full duration.

**Verification:** Lock-under-callback fully traced: ingest_response locks the engine mutex (ffi.rs:160), engine.ingest publishes while &mut self is held (engine.rs:145-150), PubSub::publish invokes the sink synchronously (pubsub.rs:44-48), and the sink calls the raw C callback directly (ffi.rs:371-386). Any synchronous re-entrant engine_* call from that callback re-locks ffi.inner on a non-reentrant std::sync::Mutex — std documents this as 'might panic or deadlock'. One correction: the CURRENT C++ consumer does not trigger it — eventTrampoline copies the strings and defers via jsInvoker_->invokeAsync, so this is a latent footgun for any other/future FFI consumer, not an active deadlock. The secondary claim (callback duration blocks the flusher thread and all FFI calls) is true.

**Fix sketch:** Collect (channel, payload) pairs during ingest and invoke the sink after the MutexGuard is dropped in the FFI layer (e.g. ingest returns pending events; engine_execute/ingest_response fires them post-unlock), or dispatch sink invocations to a dedicated delivery thread/queue.

### S8. engine_close frees the EngineFfi with no guard against in-flight calls or double-close — `packages/reconcile-engine/rust/src/ffi.rs:409` [CONFIRMED]

**Finding (F15):** engine_close frees the EngineFfi (Box::from_raw) with no guard against in-flight calls or double-close, despite the Arc<Mutex> design inviting cross-thread use.

**Failure:** Thread B is inside engine_execute/engine_ingest_direct holding &EngineFfi (it never clones the Arc; refcount stays 1) while thread A calls engine_close. A joins the flusher, flushes, then drops the Box — freeing the EngineFfi and, via the last Arc, the Mutex<Engine> while B is blocked on or holding that mutex: use-after-free/UB, possible mid-ingest corruption of the response. Calling engine_close twice is a double-free; engine_execute after close is use-after-free.

**Verification:** engine_close (ffi.rs:409-427) unconditionally Box::from_raw's the handle; every entry point borrows &EngineFfi without cloning the Arc (e.g. ffi.rs:109/113), so Arc refcount stays 1. Traceable path: thread B blocked in ffi.inner.lock() at ffi.rs:113 while thread A's engine_close completes lines 411-425 and drops the Box -> last Arc frees Mutex<Engine> under B = use-after-free; a second engine_close on the same handle is a double Box::from_raw = double free. No guard, and engine_close has no documented contract in engine.h. clippy's not_unsafe_ptr_arg_deref failures corroborate. Mitigating: the only current caller serializes all access and nulls engine_ under engineMutex_ (NativeReconcileEngine.cpp:70-75, 134-140), so it is not triggerable from the shipped C++ today.

**Fix sketch:** Keep handles in a registry (id -> Arc<EngineFfi>) so FFI entry points clone the Arc and close merely removes the registry entry (last caller drops it), or at minimum have each entry point clone ffi.inner before use and document/enforce the single-close, no-concurrent-close contract.

### S9. FFI entry points call ffi.inner.lock().unwrap(); one panic while holding the… — `packages/reconcile-engine/rust/src/ffi.rs:113` [CONFIRMED]

**Finding (F16):** FFI entry points call ffi.inner.lock().unwrap(); one panic while holding the engine mutex poisons it, after which every subsequent FFI call panics inside an extern "C" fn and aborts the process; engine_close's 'if let Ok' then also silently skips the final kv flush and WAL checkpoint.

**Failure:** Any panic under the lock (e.g. a rayon merge worker, an arithmetic overflow in a debug build) poisons the mutex. The next engine_execute/engine_kv_get unwraps Err(PoisonError) and panics across the C ABI boundary, aborting the app. If the app instead reaches engine_close, the poisoned lock makes close skip flush_kv and the checkpoint, losing acknowledged write-behind kv sets with no error reported.

**Verification:** Eight lock().unwrap() sites (ffi.rs:113,130,160,228,250,284,331,367). The poison-then-continue path is genuinely reachable: a panic in flush_kv on the Rust flusher thread (ffi.rs:83-85) kills only that thread (plain std::thread, no extern boundary) and poisons the mutex; the next FFI call's unwrap then panics inside an extern "C" fn and, with no catch_unwind and panic=unwind on rustc 1.95 (>=1.81), aborts the process. engine_close's if-let-Ok at ffi.rs:417 verifiably skips the final flush_kv and wal_checkpoint on poison, silently dropping acknowledged write-behind sets. Caveat: the multi-call poison scenario specifically requires the initial panic on the flusher (or another non-FFI) thread.

**Fix sketch:** Recover from poisoning (lock().unwrap_or_else(|p| p.into_inner()) — engine state is SQLite-backed and safe to reuse) or match on the poison error and return an error envelope; in engine_close, flush and checkpoint via into_inner() and report failures through set_last_error.

### S10. del() and purge_if_expired() issue three separate DELETEs (kv, hash, key_ttl)… — `packages/reconcile-engine/rust/src/commands.rs:107` [CONFIRMED]

**Finding (F17):** del() and purge_if_expired() issue three separate DELETEs (kv, hash, key_ttl) as individual autocommit statements instead of one transaction.

**Failure:** Process is killed between 'DELETE FROM kv' and 'DELETE FROM hash' inside del(): after restart the key's kv value is gone but its hash fields survive, so hgetall/scan resurrect a half-deleted key. Same window exists in purge_if_expired, where a partially purged expired key can leave hash rows behind (with the ttl row also gone if the kill lands after the third statement started).

**Verification:** commands.rs:107-109 (del) and commands.rs:30-32 (purge_if_expired) each run three store.conn.execute DELETEs (kv, hash, key_ttl) as separate autocommit statements — no conn.transaction() or BEGIN anywhere in either function, and no caller wraps them. Each execute commits independently in WAL mode, so a kill between the kv and hash DELETEs durably leaves hash rows (and the ttl row) for a half-deleted key, which scan (commands.rs:181, UNION over hash) and hgetall then resurface. Contrast flush_kv (engine.rs:63-77), which correctly uses a transaction — the pattern exists in the codebase but was not applied here.

**Fix sketch:** Wrap the three DELETEs in a single transaction (conn.transaction() / execute_batch with BEGIN..COMMIT) in both del() and purge_if_expired(); this requires threading &mut access or using an explicit BEGIN IMMEDIATE via execute_batch.

### S11. Real SQLite errors are swallowed by '.ok()' / 'unwrap_or(false)' and treated as… — `packages/reconcile-engine/rust/src/commands.rs:27` [CONFIRMED]

**Finding (F18):** Real SQLite errors are swallowed by '.ok()' / 'unwrap_or(false)' and treated as 'row not found': purge_if_expired (line 27), get (lines 63, 71), expire's EXISTS probe (line 216), and ttl (line 246) all conflate I/O/corruption errors with absence, and expire then reports a code-4 Command error ('cannot expire missing key') for what is actually a code-2 storage failure.

**Failure:** Disk I/O error or page corruption during 'SELECT value FROM kv' makes get() return Ok(None) — the app sees a clean 'key does not exist' and may proceed to overwrite or drop state. expire() on a real, present key returns 'cannot expire missing key' (code 4) when the EXISTS query fails, telling the caller a lie about both the key and the error class.

**Verification:** All five cited sites verified: purge_if_expired commands.rs:27 (.ok() on the expires_at query), get commands.rs:63 (.ok() on SELECT value — an I/O/corruption error becomes Ok(None), i.e. 'key missing') and :71 (.ok() on the TTL fill), expire commands.rs:216 (unwrap_or(false) on the EXISTS probe, after which line 218 returns EngineError::Command — code 4 per error.rs:17 — 'cannot expire missing key' for what is actually a Storage/code-2 failure), and ttl commands.rs:246 (.ok()). rusqlite's query_row returns Err(QueryReturnedNoRows) for absence, so .ok() is the intended miss-handling but demonstrably swallows every other error class into 'absent'.

**Fix sketch:** Replace '.ok()' with optional() (rusqlite's OptionalExtension), propagating every error other than QueryReturnedNoRows as EngineError::Storage; replace unwrap_or(false) in expire with '?'.

### S12. The background flusher swallows flush_kv errors ('let _ =') with no backoff… — `packages/reconcile-engine/rust/src/ffi.rs:84` [CONFIRMED]

**Finding (F19):** The background flusher swallows flush_kv errors ('let _ =') with no backoff, logging, or caller-visible signal, and flush failure re-queues writes indefinitely; engine_close also ignores its final flush_kv error.

**Failure:** Disk full / persistent I/O error: engine_kv_set keeps returning true, each 100 ms flush fails silently, and kv.pending grows without bound in RAM (set() re-queues on every failure once high_water is exceeded flush attempts fail too). On close the final 'let _ = engine.flush_kv()' fails silently and every acknowledged-but-unflushed set is dropped with no error ever surfaced to the host app.

**Verification:** Core claims verified: the flusher swallows flush_kv errors with let _ = (ffi.rs:84) with no backoff/logging/last_error, flush_kv re-queues failed writes indefinitely (engine.rs:79-88), and engine_close ignores the final flush error (ffi.rs:418), silently losing acknowledged sets. One scenario detail corrected: engine_kv_set does NOT keep returning true unboundedly — commands.rs set() propagates the flush error via engine.flush_kv()? once pending >= high_water (commands.rs:95-97), so after 256 queued writes the caller gets false plus last_error (though each failed set still queues its entry first, so pending still creeps up by 1 per call). That correction narrows the blast radius but does not refute the silent-flusher / silent close-time-loss defect.

**Fix sketch:** Record flusher/close flush failures via set_last_error or a sticky engine-level error flag surfaced on the next command, cap pending (fail engine_kv_set once the retry queue exceeds a bound), and add backoff so a dead disk isn't hammered every 100 ms.

### S13. dead_letter grows without bound — `packages/reconcile-engine/rust/src/reconcile.rs:407` [CONFIRMED]

**Finding (F20):** dead_letter grows without bound: every reject inserts a row containing the full source fragment, and the only API that touches the table afterwards is deadLetterCount — there is no purge, cap, or TTL anywhere in the codebase.

**Failure:** A source that persistently emits malformed records (e.g. a schema change upstream) dead-letters every fragment on every sync, forever. On a mobile device the SQLite file grows monotonically with full payload fragments until the app hits storage pressure; nothing ever reads or deletes the rows.

**Verification:** Verified by exhaustive grep over rust/src, rust/tests, src/, and cpp/: dead_letter is written by the INSERT at reconcile.rs:406-412 (one row per reject, full fragment, every batch), created at store.rs:37-43, and the ONLY other access in the entire codebase is dispatch.rs:110-116 deadLetterCount, a SELECT count(*). There is no DELETE FROM dead_letter, no cap, no retention window, no drain/clear command in the dispatch table (lines 45-116), and no TTL mechanism (key_ttl applies only to kv keys). A persistently malformed source therefore grows the table monotonically with full payload fragments, unbounded.

**Fix sketch:** Cap the table (DELETE oldest rows beyond N per source inside the same reconcile transaction, or prune rows older than a retention window on open), and/or expose a deadLetterDrain/clear command.

### S14. Nothing prevents opening the same database path twice (no… — `packages/reconcile-engine/rust/src/store.rs:61` [CONFIRMED]

**Finding (F21):** Nothing prevents opening the same database path twice (no locking_mode=EXCLUSIVE, no busy_timeout, no handle registry), yet each Engine has an independent write-behind KvCache with no cross-connection invalidation.

**Failure:** React Native dev reload (or any host bug) opens a second engine on the same file before closing the first. Engine A serves kv reads from its in-memory map forever, never seeing B's committed writes (stale reads with no expiry); concurrent writes collide with immediate SQLITE_BUSY (no busy_timeout is set), which flush_kv turns into silently-retried queue growth and reconcile turns into failed ingests. A's close-time wal_checkpoint(TRUNCATE) also silently fails under B's readers.

**Verification:** Core claim confirmed: engine_open has no path registry and Store::open sets no locking_mode=EXCLUSIVE, so two engines on one file are freely constructible; each has an independent KvCache, and commands::get serves cache hits from kv.map with no cross-connection invalidation (commands.rs:50-52) — engine A never observes B's committed kv writes for any key it has cached, with no expiry. The close-time checkpoint failure is also silently swallowed (ffi.rs:418-423). One sub-claim REFUTED: 'no busy_timeout / immediate SQLITE_BUSY' is wrong — rusqlite 0.32.1 installs a default 5000 ms busy timeout on every Connection::open (verified in rusqlite source), so concurrent writers block up to 5 s before failing. That softens the write-collision story but does not touch the stale-read defect, which is the substantive one.

**Fix sketch:** Set PRAGMA busy_timeout on open, and either take locking_mode=EXCLUSIVE for file DBs or keep a process-wide registry of open canonical paths in engine_open that rejects a second open of the same file.

### S15. The per-source payload skip compares only a 64-bit DefaultHasher hash of the… — `packages/reconcile-engine/rust/src/engine.rs:119` [CONFIRMED]

**Finding (F22):** The per-source payload skip compares only a 64-bit DefaultHasher hash of the raw payload: it ignores source-config changes, and a hash collision silently drops a batch.

**Failure:** registerSource is called again for the same source_id with a changed config (different priority, natural_key_field, collection); re-ingesting the byte-identical payload is skipped, so the data is never reconciled under the new rules. Separately, a different payload that collides on the 64-bit hash is reported skipped=true and never stored. DefaultHasher's algorithm is also unspecified across Rust releases, so an app update can invalidate all stored hashes (fail-safe, but silently defeats the optimization).

**Verification:** Traced: ingest hashes only the raw payload with fixed-key DefaultHasher (engine.rs:106-108) and skips when it equals sync_meta.content_hash for the source; registerSource (dispatch.rs:92-96) only does engine.sources.insert and never clears the stored hash. So re-registering a source with a changed config and re-ingesting the byte-identical payload returns skipped=true and the data is never reconciled under the new rules — silent, though a careful caller could notice skipped=true. The collision claim is mechanically correct and the cross-release hash instability is fail-safe as stated. Re-graded up from noted: the config-change staleness is a genuine silent-data-omission footgun, not a nit.

**Fix sketch:** Fold a hash/fingerprint of the SourceConfig into the stored content_hash (and clear it on registerSource), and use a wider, stable hash (e.g. SHA-256 or xxh3-128 with fixed seed) for the skip comparison.

### S16. No catch_unwind in any extern "C" fn — `packages/reconcile-engine/rust/src/ffi.rs:114` [CONFIRMED]

**Finding (F25):** No catch_unwind in any extern "C" fn: panics from dispatch::execute, Engine::open, rusqlite, or CString handling unwind straight into the FFI boundary. On Rust >=1.81 this aborts the whole app process; on older toolchains (or panic=unwind cdylib configs) it is undefined behavior.

**Failure:** A malformed request JSON or an internal invariant violation panics inside execute() while engine_execute is on the stack; the React Native app hard-crashes with no error envelope, and the mutex is left poisoned for every other caller (see poisoning finding).

**Verification:** Structural claim verified: zero catch_unwind in the crate, no [profile] panic setting in Cargo.toml (panic="unwind" per target/.rustc_info.json), toolchain rustc 1.95.0 >= 1.81 — so any panic inside the 14 extern "C" fns hits the abort-on-unwind shim: whole-app abort with no error envelope (defined abort, not UB). Real panic sites under the boundary exist (ffi.rs:163 unwrap, engine.rs:146 unwrap, the lock().unwrap() poison path, debug-build overflow in commands.rs expire). However the finding's headline trigger is refuted: malformed request JSON does NOT panic — dispatch.rs:28-29 maps it to an error envelope, locked in by test malformed_request_is_error_envelope_not_panic (dispatch.rs:198). No release-build panic reachable from external input was demonstrated, so this is a missing containment layer that converts any future internal bug into a full app abort, not a traceable crash today. Re-graded critical -> should-fix.

**Fix sketch:** Wrap the body of every extern "C" fn in std::panic::catch_unwind(AssertUnwindSafe(..)); on Err, set_last_error(500, "internal panic") and return the error envelope / null / false. Alternatively build the cdylib with panic=abort and accept process death, but catch_unwind preserves the error-envelope contract.

### S17. globToRegex diverges from Rust glob.rs — `packages/reconcile-engine/src/index.ts:83` [CONFIRMED]

**Finding (F33):** globToRegex diverges from Rust glob.rs: '.*' without the 's' flag does not match newlines, while Rust '*' matches any character

**Failure:** A collection name (echoed into the 'changes:{collection}' channel) containing a newline: Rust glob_match fires the native sink and the event reaches JS, but re.test(e.channel) fails, so the handler is silently never called. The TS filter is strictly narrower than the native one that admitted the event. Also untested: no TS test exercises globToRegex against the Rust test vectors.

**Verification:** index.ts:83-84 builds new RegExp('^'+escaped+'$') with no 's' flag, so '*'->'.*' excludes \n (and \r, \u2028/\u2029). Verified with node: globToRegex('changes:*').test('changes:foo\nbar') === false, while adding 's' gives true. Rust glob.rs:21-42 matches per-char with no restriction, so the native sink fires but the JS listener at index.ts:94 silently drops the event. TS filter is strictly narrower than the Rust matcher; index.test.ts has exactly one subscribe test with no glob vectors. Trigger requires a newline-bearing collection/channel name (dev-controlled), so real-world exposure is low, but the parity contract is genuinely violated and the failure is silent.

**Fix sketch:** new RegExp(`^${escaped}$`, 's'), or replace the regex with a direct port of the two-pointer glob_match; add a shared test-vector table mirroring glob.rs tests.

### S18. subscribe listener has no try/catch — `packages/reconcile-engine/src/index.ts:94` [CONFIRMED]

**Finding (F34):** subscribe listener has no try/catch: handler exceptions and JSON.parse failures propagate into native event-emitter dispatch

**Failure:** With multiple overlapping subscriptions, each is a separate listener on the shared onChange emitter. If one handler throws (or e.payload is ever non-JSON — e.g. a NUL-sanitized payload), the exception escapes into the emitter's dispatch loop: later listeners for the same event can be skipped and the error surfaces as an uncaught global error, breaking sibling subscriptions.

**Verification:** index.ts:93-95: the onChange listener body has no try/catch — a throwing handler or non-JSON payload escapes the listener. One correction to the claimed blast radius: in RN 0.86's real dispatch (AsyncEventEmitter::emit) each listener is invoked via its own invokeAsync task, so sibling listeners are NOT skipped in production — the exception instead surfaces as an uncaught global JS error per throwing listener (fatal in RN release builds). Sibling-skipping does occur in the test mock (rn-mock.ts:10 forEach). Core defect fully traced; the sibling-skip subclause is environment-dependent.

**Fix sketch:** Wrap the body in try/catch (log or route to an onError option); parse the payload once per event and guard per-handler invocation separately.

### S19. unsubscribe is fire-and-forget with `void call(...)` — `packages/reconcile-engine/src/index.ts:98` [CONFIRMED]

**Finding (F35):** unsubscribe is fire-and-forget with `void call(...)`: rejection becomes an unhandled promise rejection and the native sub can leak

**Failure:** closeEngine() then unsub(): execute rejects 'engine not open' and nothing catches it — unhandled rejection warning/crash-on-strict. If the unsubscribe command fails for any reason the Rust-side Sub stays registered forever (the JS listener was already removed, so events keep firing the native sink and crossing the bridge for no listener). Local ordering (remove() before native unsubscribe) is correct.

**Verification:** index.ts:96-99: the returned closure does sub.remove(); void call('unsubscribe', [String(id)]) — the promise is discarded with void, no .catch. Concrete rejection path: closeEngine() sets engine_=nullptr (NativeReconcileEngine.cpp:134-140); a subsequent unsub()'s execute task hits engine_ == nullptr -> promise.reject("engine not open") (cpp:146-148), producing an unhandled promise rejection. And when the unsubscribe command fails while the engine is open, the Rust-side Sub stays registered (dispatch.rs:86-91 only removes on a successful command), so the native sink keeps firing with no JS listener. Closure is also non-idempotent as claimed.

**Fix sketch:** Append .catch(() => {}) (or log), and make the returned closure idempotent.

### S20. Double open silently no-ops even with a different path — `packages/reconcile-engine/cpp/NativeReconcileEngine.cpp:124` [CONFIRMED]

**Finding (F37):** Double open silently no-ops even with a different path: openEngine('/b') after openEngine('/a') resolves successfully but the engine still points at /a

**Failure:** A caller switching databases (logout/login, test isolation) calls openEngine with a new path; the promise resolves with no error, and every subsequent read/write silently targets the old database file. The comment marks idempotency as intentional for the sandbox, but the JS-facing contract reports success for an open that did not happen.

**Verification:** Directly traceable: open() (cpp:122-125) returns early whenever engine_ != nullptr without comparing the requested path to the currently open one — the stored path is not even retained. TS openEngine just calls open(path) and resolves void, so openEngine('/b') after openEngine('/a') resolves successfully while every subsequent operation targets /a. The in-code comment documents intentional idempotency but not the different-path case; a logout/login database switch silently reads/writes the previous user's database. Footgun with wrong-database consequences but no corruption: should-fix stands.

**Fix sketch:** Throw (or return a distinguishable result) when open is called with a different path while already open; only no-op when the path matches.

### S21. open failure loses EngineError code fidelity — `packages/reconcile-engine/cpp/NativeReconcileEngine.cpp:129` [CONFIRMED]

**Finding (F38):** open failure loses EngineError code fidelity: the Rust error JSON is embedded verbatim inside a plain JSError message string

**Failure:** engine_open on a bad path sets last_error to '{"code":2,"message":...}' and open throws JSError('engine_open failed: {"code":2,...}'). JS receives a generic Error whose message contains raw JSON; catch blocks checking `e instanceof EngineError` or `e.code` (the pattern unwrap() establishes) never match, and the user-visible message is JSON soup (App.tsx renders String(e)).

**Verification:** Directly traceable: on open failure, engine_open sets last_error to a JSON envelope like {"code":2,"message":...} (ffi.rs:89-92), and cpp:127-129 does throw jsi::JSError(rt, "engine_open failed: " + err) embedding that raw JSON verbatim. TS openEngine does no parsing or rewrapping, so callers get a generic Error whose message contains JSON text; the EngineError(code, message) contract that unwrap() establishes never applies — e instanceof EngineError and e.code checks fail for open errors. Error-contract inconsistency plus JSON-soup user-visible messages: should-fix is right.

**Fix sketch:** Parse the last-error JSON in C++ (or in openEngine TS) and rethrow as EngineError(code, message).

### S22. execute/ingestDirect reject with the bare string 'engine not open', bypassing… — `packages/reconcile-engine/cpp/NativeReconcileEngine.cpp:147` [CONFIRMED]

**Finding (F39):** execute/ingestDirect reject with the bare string 'engine not open', bypassing the JSON envelope contract that unwrap()/EngineError establish

**Failure:** A call racing closeEngine() (execute posts to the worker; a JS-thread close can run before the worker dequeues the task) rejects with a plain string/Error instead of an ok:false envelope. Callers of redis.*/ingest get an error with no .code and not instanceof EngineError, so error-branching logic written against EngineError silently falls through. Same at line 164 for ingestDirect.

**Verification:** Directly traceable: execute (cpp:146-148) and ingestDirect (cpp:163-165) do promise.reject("engine not open") — a bare message, not the ok:false JSON envelope. The rejection bypasses unwrap() entirely, so callers get an error with no .code and not instanceof EngineError, unlike every other engine failure. The race is real: execute() posts the task to the worker queue and returns; a JS-thread closeEngine() can acquire engineMutex_, engine_close, and null engine_ before the worker dequeues the task. Note the Rust layer itself handles the analogous case with a proper envelope (ffi.rs:106-108, code 4), so the C++ layer is the odd one out. should-fix stands.

**Fix sketch:** Reject with the canonical envelope (resolve '{"ok":false,"code":4,"message":"engine not open"}' so unwrap converts it), or construct EngineError-compatible rejections in TS.

### S23. kvGet conflates 'key missing' with 'storage error' — `packages/reconcile-engine/cpp/NativeReconcileEngine.cpp:327` [CONFIRMED]

**Finding (F40):** kvGet conflates 'key missing' with 'storage error': nullptr from engine_kv_get returns undefined without consulting engine_last_error

**Failure:** ffi.rs documents engine_kv_get returning NULL for missing key OR error (it calls set_last_error on the error path). The C++ host function returns jsi::Value::undefined() for both, so a SQLite failure reads as a cache miss — callers treat corrupted/failed reads as 'no value' and may overwrite good data. The stale thread-local last error then leaks into the next unrelated failure message.

**Verification:** Directly traceable contract mismatch: ffi.rs:217-218 documents engine_kv_get returning NULL 'when the key is missing or on error (see engine_last_error)', and the implementation distinguishes them internally — Ok(None) returns null silently while Err sets last_error first (ffi.rs:230-237). The C++ kvGet host function (cpp:326-328) collapses both to undefined without ever consulting engine_last_error. The error branch is reachable: commands::get propagates prepare_cached failures and purge_if_expired's DELETE failures via ? — though query_row errors are swallowed by .ok() (the F18 issue), which narrows but does not eliminate the path. A storage-layer failure surfaces to JS as a clean cache miss, and the stale thread-local last_error can later be read by a nullptr path that sets no fresh error. should-fix stands.

**Fix sketch:** Add an out-param or sentinel to engine_kv_get distinguishing miss from error (e.g. engine_kv_get(handle, key, &err_flag)), and throw JSError on the error case.

### S24. Unmount-before-subscribe-resolves leaks the subscription — `apps/sandbox/src/screens/EntriesScreen.tsx:22` [CONFIRMED]

**Finding (F44):** Unmount-before-subscribe-resolves leaks the subscription: cleanup runs while `unsub` is still undefined

**Failure:** subscribe() is async; if EntriesScreen unmounts (tab switch) before the promise resolves, the effect cleanup reads unsub === undefined and does nothing. The native subscription and JS listener persist for the app lifetime, and every 'changes:people' event calls refresh() -> setRows on an unmounted component, plus redundant scan/hgetall traffic on every ingest.

**Verification:** EntriesScreen.tsx:19-24: let unsub; void subscribe(...).then((u) => (unsub = u)); return () => unsub?.(). subscribe() genuinely suspends (index.ts:91 awaits the native subscribe command through the C++ worker thread), so an unmount before resolution runs cleanup while unsub is undefined, and when the promise later resolves the JS listener and Rust-side sub exist with nothing ever calling unsub. Every subsequent 'changes:people' event invokes refresh() -> scan + N hgetall calls + setRows on the unmounted component, for the app lifetime. Resource/perf leak, not data corruption.

**Fix sketch:** Track a cancelled flag in the effect: if cancelled when the promise resolves, call the returned unsub immediately instead of storing it.

### S25. No source/binary drift guard anywhere — `packages/reconcile-engine/scripts/build-android.sh:1` [CONFIRMED]

**Finding (F47):** No source/binary drift guard anywhere: no CI (.github absent), no hash manifest, no build-time freshness check comparing rust/src mtimes or content hashes against the produced .a. Currently the local artifacts (built Jul 17 02:01) are newer than the newest rust source (ffi.rs), and the 14 exported engine_* symbols match cpp/include/engine.h, but that is luck, not enforcement.

**Failure:** A developer edits rust/src/ffi.rs (e.g. changes engine_ingest_bytes semantics or adds a function) and forgets to rerun the build scripts. iOS/Android builds succeed against the stale .a — CMake/Xcode treat it as an opaque prebuilt input — and the app silently runs old native code; for an added symbol the failure surfaces only as an undefined-symbol link error, for changed behavior it never surfaces at build time.

**Verification:** No .github directory exists, no CI yml/yaml anywhere outside node_modules, no manifest/hash file in ios-rust/ or android-rust/, and neither build script writes one — nothing compares rust/src against the prebuilt .a. Side-claims check out: artifacts dated Jul 17 02:01 vs newest source ffi.rs Jul 17 01:55 (currently fresh by luck), and the arm64-v8a .a exports exactly 14 T engine_* symbols matching engine.h's declarations.

**Fix sketch:** Have build scripts write a manifest (git SHA of rust/ tree + rustc version + sha256 of each .a) next to the artifacts; add a CI job or preBuild/pod-install hook that recomputes the rust/ tree hash and fails when it differs from the manifest.

### S26. No toolchain pinning — `packages/reconcile-engine/rust/Cargo.toml:4` [CONFIRMED]

**Finding (F48):** No toolchain pinning: no rust-toolchain.toml anywhere in the repo, no rust-version (MSRV) in Cargo.toml (only edition = 2021). Local builds used whatever stable resolves to (rustc 1.95.0 per rust/target/.rustc_info.json). Scripts also assume, without checking, that cargo-ndk is installed and that the four rustup targets (aarch64-apple-ios, aarch64-apple-ios-sim, aarch64-linux-android, x86_64-linux-android) are added, and build-android.sh passes no --platform (min-SDK) flag so the Android API level depends on the installed cargo-ndk's default.

**Failure:** Two developers (or dev vs future CI) produce byte-different, behaviorally divergent .a files from identical sources; a fresh machine running scripts/build-ios.sh dies with 'error[E0463]: can't find crate for core' (target not installed) and build-android.sh with 'cargo: no such command: ndk', with no guidance.

**Verification:** Repo-wide find (excluding node_modules/target) finds no rust-toolchain.toml; rust/Cargo.toml has only edition = "2021", no rust-version. target/.rustc_info.json shows the local build used the floating stable-aarch64-apple-darwin toolchain. Both scripts invoke cargo/cargo-ndk with no preflight check for cargo-ndk or installed rustup targets, and build-android.sh line 9 passes no --platform flag, so min-SDK depends on cargo-ndk's default.

**Fix sketch:** Add rust-toolchain.toml pinning the channel and listing the four targets; add rust-version to Cargo.toml; have both scripts verify cargo ndk --version / rustup target list --installed up front and pass an explicit --platform 24 (or chosen minSdk) to cargo ndk.

### S27. Android ABI coverage is arm64-v8a + x86_64 only. The sandbox compensates via… — `packages/reconcile-engine/scripts/build-android.sh:9` [CONFIRMED]

**Finding (F49):** Android ABI coverage is arm64-v8a + x86_64 only. The sandbox compensates via reactNativeArchitectures=arm64-v8a,x86_64 in apps/sandbox/android/gradle.properties (acknowledged in the CMake comment at apps/sandbox/android/app/src/main/jni/CMakeLists.txt:21), but the package itself ships nothing for armeabi-v7a or x86.

**Failure:** A consumer app with RN's default reactNativeArchitectures (all four ABIs) fails the armeabi-v7a/x86 CMake link because IMPORTED_LOCATION points at a nonexistent file; if they instead restrict ABIs, 32-bit-only Android devices (still common on low-end hardware) can't install/run the app. x86 emulators on older setups are likewise unsupported.

**Verification:** build-android.sh line 9 builds only -t arm64-v8a -t x86_64, and android-rust/ contains only those two dirs. apps/sandbox/android/gradle.properties:33 restricts reactNativeArchitectures=arm64-v8a,x86_64, and the CMakeLists.txt comment explicitly acknowledges the restriction. No armeabi-v7a or x86 libs exist anywhere, so a consumer with RN's default four-ABI setting would fail the CMake link for the missing ABIs.

**Fix sketch:** Either add -t armeabi-v7a -t x86 to the cargo ndk invocation (all are tier-2 rust targets) or document the ABI restriction as a hard requirement of the package and make CMake fail with a clear message for unsupported ABIs.

### S28. iOS simulator slice is arm64-only (only aarch64-apple-ios-sim is built… — `packages/reconcile-engine/scripts/build-ios.sh:6` [CONFIRMED]

**Finding (F50):** iOS simulator slice is arm64-only (only aarch64-apple-ios-sim is built; xcframework Info.plist confirms ios-arm64-simulator supports just arm64, verified with lipo). No x86_64 simulator slice and no Mac Catalyst slice; the sandbox Podfile sets :mac_catalyst_enabled => false so Catalyst is consistently unsupported, but nothing states this.

**Failure:** Anyone building for the simulator on an Intel Mac gets undefined _engine_* symbols for x86_64 (or 'building for iOS Simulator, but linking in object file built for iOS Simulator arm64' style errors). Any future attempt to enable Mac Catalyst fails because the xcframework has no ios-arm64-macabi library.

**Verification:** build-ios.sh builds only aarch64-apple-ios and aarch64-apple-ios-sim (lines 5-6). lipo -info on both xcframework slices reports 'Non-fat file ... architecture: arm64', and Info.plist lists SupportedArchitectures = [arm64] for both slices — no x86_64 simulator slice and no macabi library. apps/sandbox/ios/Podfile:63 sets :mac_catalyst_enabled => false as claimed. Intel-Mac simulator builds would fail to link _engine_* symbols; nothing documents the restriction.

**Fix sketch:** Build x86_64-apple-ios too and lipo -create it with the arm64 sim lib before xcodebuild -create-xcframework (one fat simulator slice); add Catalyst targets only if needed, otherwise document Apple-silicon-only simulator support.

### S29. The package is not self-contained on Android — `apps/sandbox/android/app/src/main/jni/CMakeLists.txt:7` [CONFIRMED]

**Finding (F51):** The package is not self-contained on Android: packages/reconcile-engine has no android/ directory at all (no build.gradle, no CMake, no AAR), so Android autolinking contributes nothing. All Android glue lives in the sandbox app: (1) jni/CMakeLists.txt compiling ${PKG}/cpp/NativeReconcileEngine.cpp and importing ${PKG}/android-rust/${ANDROID_ABI}/libreconcile_engine.a via a hardcoded 7-level relative path; (2) jni/OnLoad.cpp, a hand-edited copy of RN 0.86's default-app-setup OnLoad.cpp registering the module in cxxModuleProvider; (3) a custom generateAppLevelCodegen Exec task in app/build.gradle invoking react-native's internal scripts/generate-codegen-artifacts.js, wired via mustRunAfter/dependsOn onto preBuild and configureCMake/buildCMake; (4) the gradle.properties ABI restriction.

**Failure:** A fresh consumer app that just adds the npm dependency gets a JS module that throws at runtime (TurboModuleRegistry.getEnforcing fails) on Android. To make it work they must replicate all four pieces above, and the CMake set(PKG .../../../../../../../packages/reconcile-engine) path assumes the exact monorepo layout — an npm-installed (non-workspace) copy lives under node_modules and the path is wrong. The copied OnLoad.cpp and the generate-codegen-artifacts.js invocation are RN-0.86-internal shapes and will silently drift on RN upgrades.

**Verification:** packages/reconcile-engine contains no android/ directory (no build.gradle/CMake/AAR), so autolinking contributes nothing on Android; all four claimed app-side glue pieces verified exactly as described: jni/CMakeLists.txt:7,11,24 (hardcoded 7-level path, compiles the package's NativeReconcileEngine.cpp, IMPORTED_LOCATION on android-rust/${ANDROID_ABI}/libreconcile_engine.a), hand-edited jni/OnLoad.cpp registering the module in cxxModuleProvider, build.gradle:149-165 generateAppLevelCodegen Exec task invoking react-native's internal scripts/generate-codegen-artifacts.js, and gradle.properties:33 ABI restriction. package.json codegenConfig has an ios section but no android section. An npm-installed copy under node_modules would break the fixed relative path.

**Fix sketch:** Give the package an android/ project (gradle library with its own CMakeLists and a ReactPackage/TurboReactPackage or cxxModuleProvider registration via the library-level codegen), so autolinking handles it; failing that, ship a consumer-setup doc listing exactly these four required app-side changes and derive PKG from node --print require.resolve(...) instead of a fixed relative path.


## Noted

- **N1 (F8).** Short-circuit trusts a persisted 64-bit fixed-key DefaultHasher digest as content equality; a collision silently drops a record that introduces a new field — `packages/reconcile-engine/rust/src/reconcile.rs:191`
- **N2 (F9).** Only '*' is supported; Redis-glob '?' and '[...]' match literally with no error — `packages/reconcile-engine/rust/src/glob.rs:12`
- **N3 (F10).** Duplicate CSV header columns silently collapse: the last duplicate column's value wins — `packages/reconcile-engine/rust/src/normalize.rs:181`
- **N4 (F11).** hgetall on entry:* keys injects _updated_at, silently overwriting a genuine source field of that name — `packages/reconcile-engine/rust/src/commands.rs:155`
- **N5 (F23).** expire computes now_ms + ttl_ms with unchecked addition on caller-supplied ttl_ms: overflow panics in debug builds (reachable from command input through dispatch), and wraps to a negative expires_at in release, instantly expiring the key. — `packages/reconcile-engine/rust/src/commands.rs:223`
- **N6 (F24).** KvCache.map and .ttl grow without bound: every key ever set or read-through is cached in RAM forever with no eviction, so the cache asymptotically holds the entire kv table. — `packages/reconcile-engine/rust/src/engine.rs:16`
- **N7 (F27).** Length prefixes are written with `len as u32` (also lines 3, 5, 7, 25, 27, 30, 32, 46): a key/value/field of >= 4 GiB silently truncates the prefix while the full bytes are still appended, frame-shifting the rest of the buffer. Additionally a value of exactly u32::MAX bytes collides with the SCHEMA_FIELD_MISSING sentinel and would decode as "missing". — `packages/reconcile-engine/rust/src/binenc.rs:41`
- **N8 (F28).** engine_ingest_bytes builds slice::from_raw_parts(payload, payload_len) trusting the caller's length; a payload_len > isize::MAX is immediate UB, and any over-claimed length is an OOB read. Inherent to a (ptr,len) C API, but the contract is not stated in engine.h line 43. — `packages/reconcile-engine/rust/src/ffi.rs:210`
- **N9 (F29).** engine_query_entries_bin (and the two schema variants, lines 305, 353) only write *out_len on success; on every NULL-returning path out_len is left untouched. — `packages/reconcile-engine/rust/src/ffi.rs:152`
- **N10 (F30).** ingest_response calls serde_json::to_value(&summary).unwrap() — a concrete panic site reachable from engine_ingest_direct / engine_ingest_bytes (extern "C"). to_value only fails for exotic Serialize impls, but it is an unwrap on a fallible API inside the FFI layer. — `packages/reconcile-engine/rust/src/ffi.rs:163`
- **N11 (F31).** queryEntriesObjects decodes u32 length fields with a raw memcpy into native byte order, while binenc.rs always writes little-endian (to_le_bytes). Alignment is handled correctly (memcpy), but the decode assumes a little-endian host. — `packages/reconcile-engine/cpp/NativeReconcileEngine.cpp:391`
- **N12 (F32).** engine_set_event_callback is given raw `this` as ctx; the Rust sink fires eventTrampoline synchronously on arbitrary threads (worker, JS fast-path, and the Rust-spawned 100 ms flusher thread) and dereferences that raw pointer. Currently sound only because close()/~NativeReconcileEngine close the engine (joining the flusher) before `this` dies, and destructor-window firings hit an expired weak_from_this so emitOnChange is skipped — but the safety argument is implicit ordering, not structure. — `packages/reconcile-engine/cpp/NativeReconcileEngine.cpp:131`
- **N13 (F36).** openEngine is async-signatured but wraps a synchronous native open that blocks the JS thread; nothing is awaited — `packages/reconcile-engine/src/index.ts:48`
- **N14 (F41).** queryEntriesSchemaBufferRange casts unvalidated doubles to long long: NaN/Infinity/out-of-range values are undefined behavior in static_cast — `packages/reconcile-engine/cpp/NativeReconcileEngine.cpp:256`
- **N15 (F42).** redis namespace diverges from Redis conventions: expire/ttl are in milliseconds, ttl returns null for both missing-key and no-TTL, expire on a missing key rejects — `packages/reconcile-engine/src/index.ts:64`
- **N16 (F43).** executeRawSync is exported on the public TS surface with no warning that it blocks the JS thread behind worker-held engineMutex_ — `packages/reconcile-engine/src/index.ts:106`
- **N17 (F45).** Test coverage gaps across the audited surface: single happy-path subscribe test; no tests for glob parity, handler throws, non-JSON payloads, unsubscribe failure, double open, or executeSync/installFastPath — `packages/reconcile-engine/src/__tests__/index.test.ts:54`
- **N18 (F52).** The post_install hook overwrites the ReactCodegen 'Generate Specs' phase input_paths with the hardcoded monorepo path ${PODS_ROOT}/../../../../packages/reconcile-engine/src/NativeReconcileEngine.ts. It exists to fix a real staleness hole (Xcode not re-running codegen when the library spec changes) but replaces all existing inputs and assumes the workspace layout and RN 0.86's phase naming. — `apps/sandbox/ios/Podfile:79`
- **N19 (F53).** build-android.sh does rm -rf "$OUT" before running cargo, so a failed build (missing NDK, missing target, compile error) leaves android-rust/ deleted with no libs at all; build-ios.sh gets this right by building first and removing the old xcframework only after cargo succeeds. — `packages/reconcile-engine/scripts/build-android.sh:6`
- **N20 (F54).** engine.h is a hand-maintained mirror of rust/src/ffi.rs (no cbindgen config or generation step anywhere). Today the 14 declarations match the 14 #[no_mangle] pub extern "C" exports, but nothing enforces it. This header is also duplicated into both xcframework Headers/ dirs at build time, adding a second copy that can go stale independently. — `packages/reconcile-engine/cpp/include/engine.h:1`
- **N21 (F55).** Publishing hygiene: no private: true and no files field. npm only honors a .gitignore inside the package directory (there is none) — the ignore rules for ios-rust/, android-rust/, and target/ live in the repo-root .gitignore, which npm pack does not read. Also codegenConfig has an ios.modulesProvider entry but no android section (works today only because the sandbox runs app-level codegen with defaults), and main points at TS source src/index.ts (fine for Metro, broken for any non-Metro consumer). — `packages/reconcile-engine/package.json:2`
- **N22 (F56).** OnLoad.cpp is a copied-and-edited RN 0.86 internal file (self-documented at the top), and app/build.gradle's generateAppLevelCodegen shells into react-native's internal scripts/generate-codegen-artifacts.js. Both couple the app to RN 0.86 internals; the Cargo.lock is committed (good) but these RN-side pins are implicit only (react-native 0.86.0 / expo ~57.0.6 in apps/sandbox/package.json — the package itself declares just react-native: *). — `apps/sandbox/android/app/src/main/jni/OnLoad.cpp:8`

## Refuted during verification

- **F26.** queryEntriesObjects bounds checks `off + klen > len` (and `off + jlen > len` at line 416, `off + 4 > len` at line 388) can wrap on 32-bit size_t. With klen near 0xFFFFFFFF, off + klen overflows, the check passes, and std::string(data + off, klen) reads ~4 GB out of bounds. — `packages/reconcile-engine/cpp/NativeReconcileEngine.cpp:411` — REFUTED: The comparison off + klen > len (cpp:411, 416) is indeed wrap-prone as written on an ILP32 target, but the claimed failure path cannot occur. (1) No 32-bit build exists: build scripts produce only arm64-v8a, x86_64, and arm64 iOS slices, and the sandbox pins reactNativeArchitectures=arm64-v8a,x86_64 — there is no armeabi-v7a artifact to run this code on; on all shipped 64-bit targets the checks are sound. (2) Even hypothetically on 32-bit, wrap requires klen >= 2^32-off; the buffer is produced in-process by encode_entries and a 32-bit process cannot hold the >=~4GiB key needed (Rust allocations capped at isize::MAX = 2^31-1), so the trigger value is unconstructible on the only platform where the check is weak. (3) Even granted an externally corrupted buffer, std::string(data+off, klen) must allocate ~4 GiB before copying; that allocation cannot succeed in a 32-bit address space, so it throws length_error/bad_alloc before a single OOB byte is read. The subtraction-form rewrite remains good hygiene, but only as a latent hardening nit.

## Coverage map

| Layer | Files read | Pass |
|---|---|---|
| TS API | src/index.ts, src/NativeReconcileEngine.ts | JSI/TS API |
| Rust core | rust/src/{reconcile,normalize,glob,commands}.rs | merge correctness |
| Rust core | rust/src/{store,engine,error,dispatch,pubsub}.rs, Cargo.toml | durability/lifecycle |
| Rust FFI | rust/src/{ffi,binenc}.rs | FFI soundness |
| C++ glue | cpp/NativeReconcileEngine.{h,cpp}, cpp/include/engine.h | FFI soundness + JSI/TS API |
| iOS glue | ios/ReconcileEngineProvider.{h,mm}, ReconcileEngine.podspec, apps/sandbox/ios (Podfile) | JSI/TS API + packaging |
| Android glue | apps/sandbox/android (jni/CMakeLists.txt, jni/OnLoad.cpp, build.gradle, gradle.properties) | packaging |
| Packaging | package.json (codegenConfig), scripts/, ios-rust/, android-rust/, .gitignore | packaging |
| Tests | src/__tests__/, rust/tests/, sandbox consumers (App.tsx, src/screens) | all passes |

Raw per-finding data (including original severities and full verdict traces): session scratchpad `audit-verified.json`.
