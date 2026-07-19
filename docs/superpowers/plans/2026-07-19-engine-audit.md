# Reconcile-Engine Full Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a verified, triaged findings report covering every layer of `packages/reconcile-engine`, ready for user review — Phase 1 of `docs/superpowers/specs/2026-07-19-engine-audit-and-real-db-rig-design.md`.

**Architecture:** Five parallel specialist review passes (one per layer/concern), each returning structured findings with file:line anchors and concrete failure scenarios. Every finding then gets an independent adversarial verification pass before it may appear in the report. Output is a single triaged markdown report; **no code is modified in this plan**.

**Tech Stack:** Claude subagents (read-only reviewers), `cargo check`/`cargo test` and `yarn test` only as read-only evidence gathering, markdown report.

## Global Constraints

- **Report-only:** no source file in `packages/reconcile-engine` may be modified. Fixes belong to the next plan.
- **Known gaps are out of scope as findings:** no tombstones, count-only change events, no scheduler — these are accepted design decisions (spec non-goals). A finding that reduces to "the engine lacks X" for those three is invalid.
- **Every reported finding needs:** exact `file:line`, a concrete failure scenario (inputs/state → wrong outcome), a severity proposal, and verification verdict CONFIRMED or PLAUSIBLE.
- **Severity ladder (from the spec):** `critical` = correctness/durability/soundness defect; `should-fix` = design flaw or footgun; `noted` = nit/deferral.
- **Commit messages:** plain, no attribution footers.
- Findings collect in scratchpad JSON files under the session scratchpad dir, one per pass: `audit-pass-<name>.json`.

---

### Task 1: Reviewer pass — Rust merge correctness

**Files (read-only):**
- `packages/reconcile-engine/rust/src/reconcile.rs`
- `packages/reconcile-engine/rust/src/normalize.rs`
- `packages/reconcile-engine/rust/src/glob.rs`
- `packages/reconcile-engine/rust/src/commands.rs`
- `packages/reconcile-engine/rust/tests/` (existing coverage)
- `docs/superpowers/specs/2026-07-16-rust-reconcile-engine-design.md` (intended semantics)

**Interfaces:**
- Consumes: nothing (first wave, runs parallel with Tasks 2–5)
- Produces: `audit-pass-merge.json` — JSON array of findings, schema: `{"file": string, "line": number, "severity": "critical"|"should-fix"|"noted", "summary": string, "failure_scenario": string, "fix_sketch": string}`

- [ ] **Step 1: Dispatch a read-only reviewer subagent with exactly this prompt**

```text
You are auditing the merge/reconcile correctness of a Rust sync engine at
packages/reconcile-engine/rust/src/. Read reconcile.rs, normalize.rs, glob.rs,
commands.rs in full, plus rust/tests/ and
docs/superpowers/specs/2026-07-16-rust-reconcile-engine-design.md for intended
semantics. Report ONLY defects in what exists — missing tombstones, count-only
change events, and missing scheduler are accepted design decisions, not findings.

Hunt specifically for:
- Field-level (timestamp, priority) merge: ties broken wrongly, per-field vs
  per-row confusion, timestamps compared as strings vs numbers inconsistently,
  backward-moving timestamps, null/absent timestamp_field handling.
- Natural-key handling: collisions, empty/null keys, key type coercion.
- Content-hash short-circuit: false positives (skipping a real change), hash
  input ordering/canonicalization.
- Normalization (normalize.rs): lossy conversions, unicode, number precision,
  CSV vs JSON asymmetries.
- Dead-letter routing: rows silently dropped instead of dead-lettered.
- glob.rs: pattern edge cases (empty pattern, '*' handling, anchoring).
- Idempotency: re-ingesting an identical batch must be a no-op; near-identical
  batches must converge.

For each defect return exact file:line, a concrete failure scenario
(inputs/state → wrong outcome), severity (critical = wrong data/corruption;
should-fix = footgun; noted = nit), and a one-line fix sketch. Your final
message must be ONLY a JSON array of finding objects with keys: file, line,
severity, summary, failure_scenario, fix_sketch. Empty array if none.
```

- [ ] **Step 2: Validate the returned JSON parses and every finding has all six keys; re-prompt the same agent to fix format if not**

- [ ] **Step 3: Write the array to `<scratchpad>/audit-pass-merge.json`**

---

### Task 2: Reviewer pass — Rust durability, transactions, engine lifecycle

**Files (read-only):**
- `packages/reconcile-engine/rust/src/store.rs`
- `packages/reconcile-engine/rust/src/engine.rs`
- `packages/reconcile-engine/rust/src/error.rs`
- `packages/reconcile-engine/rust/src/dispatch.rs`
- `packages/reconcile-engine/rust/src/pubsub.rs`
- `packages/reconcile-engine/rust/Cargo.toml` (sqlite crate + flags)

**Interfaces:**
- Consumes: nothing (first wave)
- Produces: `audit-pass-durability.json`, same finding schema as Task 1

- [ ] **Step 1: Dispatch a read-only reviewer subagent with exactly this prompt**

```text
You are auditing durability, transactions, and lifecycle of a SQLite-backed
Rust engine at packages/reconcile-engine/rust/src/. Read store.rs, engine.rs,
error.rs, dispatch.rs, pubsub.rs fully, plus Cargo.toml for the sqlite
crate/flags. Report ONLY defects in what exists; missing tombstones/changed-key
events/scheduler are accepted design decisions.

Hunt specifically for:
- Transaction boundaries: is a batch ingest atomic? Can a partial batch commit?
  Are kv writes and row writes in the same transaction when they must be?
- WAL/journal config, synchronous mode, and what a mid-write process kill can
  leave behind; is recovery-on-open sound?
- open/close lifecycle: double-open, use-after-close, close with in-flight
  ingest, reopen while WAL exists.
- Locking/concurrency: interior mutability, global state, deadlock or poisoned
  mutex paths, ordering between store writes and pubsub emission (can a
  subscriber observe the event before the data is committed, or vice versa,
  can events be lost after commit?).
- error.rs/dispatch.rs: errors swallowed, panics reachable from command input,
  error codes that lie.
- Unbounded growth: dead-letter tables, subscription registries.

Return findings as in this JSON schema — final message ONLY a JSON array,
keys: file, line, severity (critical|should-fix|noted), summary,
failure_scenario, fix_sketch. Empty array if none.
```

- [ ] **Step 2: Validate JSON as in Task 1 Step 2**

- [ ] **Step 3: Write to `<scratchpad>/audit-pass-durability.json`**

---

### Task 3: Reviewer pass — FFI soundness and memory safety

**Files (read-only):**
- `packages/reconcile-engine/rust/src/ffi.rs`
- `packages/reconcile-engine/rust/src/binenc.rs`
- `packages/reconcile-engine/cpp/NativeReconcileEngine.cpp`
- `packages/reconcile-engine/cpp/NativeReconcileEngine.h`
- `packages/reconcile-engine/cpp/include/engine.h`

**Interfaces:**
- Consumes: nothing (first wave)
- Produces: `audit-pass-ffi.json`, same finding schema

- [ ] **Step 1: Dispatch a read-only reviewer subagent with exactly this prompt**

```text
You are auditing the Rust↔C FFI boundary and its C++ consumer for soundness.
Read packages/reconcile-engine/rust/src/ffi.rs and binenc.rs, and
packages/reconcile-engine/cpp/NativeReconcileEngine.{h,cpp} and
cpp/include/engine.h, in full. This is a security/soundness pass: assume a
hostile or buggy caller.

Hunt specifically for:
- Panics crossing the FFI boundary (UB): any Rust path reachable from an
  extern "C" fn that can panic without catch_unwind.
- String/buffer ownership: who frees what; double-free, use-after-free, leaks
  on error paths; CString round-trips; non-UTF8 input from C++.
- binenc.rs binary encoding: length fields trusted without bounds checks,
  alignment assumptions, endianness, truncated-buffer reads on decode.
- Pointer lifetime of the engine handle across open/close vs concurrent calls
  from multiple threads (JS thread + any background thread).
- Callback/event emission from Rust into C++: thread it fires on, lifetime of
  captured pointers, re-entrancy.
- Null handling on every extern fn parameter and return.

Return final message as ONLY a JSON array of findings, keys: file, line,
severity (critical|should-fix|noted), summary, failure_scenario, fix_sketch.
Empty array if none.
```

- [ ] **Step 2: Validate JSON as in Task 1 Step 2**

- [ ] **Step 3: Write to `<scratchpad>/audit-pass-ffi.json`**

---

### Task 4: Reviewer pass — JSI/TurboModule glue and TS API contract

**Files (read-only):**
- `packages/reconcile-engine/cpp/NativeReconcileEngine.cpp` (JSI/fast-path angle — Task 3 covers its FFI angle)
- `packages/reconcile-engine/ios/ReconcileEngineProvider.{h,mm}`
- `packages/reconcile-engine/src/index.ts`
- `packages/reconcile-engine/src/NativeReconcileEngine.ts`
- `packages/reconcile-engine/src/__tests__/`
- `apps/sandbox/App.tsx` + `apps/sandbox/src/` (how the API is actually consumed)

**Interfaces:**
- Consumes: nothing (first wave)
- Produces: `audit-pass-api.json`, same finding schema

- [ ] **Step 1: Dispatch a read-only reviewer subagent with exactly this prompt**

```text
You are auditing the JS-facing surface of a React Native TurboModule:
packages/reconcile-engine/cpp/NativeReconcileEngine.cpp (JSI host functions,
installFastPath, ArrayBuffer returns, event emitter),
ios/ReconcileEngineProvider.{h,mm}, src/index.ts, src/NativeReconcileEngine.ts,
src/__tests__/, and its consumer apps/sandbox/. Missing tombstones/changed-key
events/scheduler are accepted design decisions, not findings.

Hunt specifically for:
- JSI: host functions capturing runtime/engine pointers that outlive them,
  ArrayBuffer ownership and detachment, calls after runtime teardown, thread
  affinity of onChange event emission vs JS thread.
- index.ts subscribe(): the glob is re-implemented in TS (globToRegex) and in
  Rust (glob.rs) — divergence between the two filters; unsubscribe race
  (events after unsubscribe, remove() vs native unsubscribe ordering); handler
  exceptions; multiple overlapping subscriptions.
- openEngine() is async-signatured but calls a sync native open without
  awaiting anything — error surfacing on bad path, double open, open-then-
  immediate-call ordering.
- Error envelope: unwrap() JSON.parse on every response — non-JSON responses,
  EngineError code fidelity, executeSync blocking the JS thread.
- Typing lies: TS types promising more than native delivers (nullability,
  BatchSummary optional fields), redis API mismatches (expire ttlMs vs
  seconds conventions).
- Test coverage gaps in src/__tests__ for any of the above.

Return final message as ONLY a JSON array of findings, keys: file, line,
severity (critical|should-fix|noted), summary, failure_scenario, fix_sketch.
Empty array if none.
```

- [ ] **Step 2: Validate JSON as in Task 1 Step 2**

- [ ] **Step 3: Write to `<scratchpad>/audit-pass-api.json`**

---

### Task 5: Reviewer pass — packaging, build, and platform glue

**Files (read-only):**
- `packages/reconcile-engine/ReconcileEngine.podspec`
- `packages/reconcile-engine/package.json` (codegenConfig)
- `packages/reconcile-engine/scripts/`
- `packages/reconcile-engine/ios-rust/` (xcframework layout, Info.plist, committed `.a`)
- `packages/reconcile-engine/android-rust/` (committed `.a`, arch coverage)
- `apps/sandbox/android/` + `apps/sandbox/ios/` (how the module links in)
- `packages/reconcile-engine/rust/Cargo.toml`

**Interfaces:**
- Consumes: nothing (first wave)
- Produces: `audit-pass-packaging.json`, same finding schema

- [ ] **Step 1: Dispatch a read-only reviewer subagent with exactly this prompt**

```text
You are auditing packaging/build of a React Native TurboModule with committed
prebuilt Rust static libs. Read ReconcileEngine.podspec, package.json
codegenConfig, scripts/, ios-rust/ (xcframework), android-rust/ (static libs),
rust/Cargo.toml, and how apps/sandbox/ios and apps/sandbox/android link it.

Hunt specifically for:
- Source/binary drift: are the committed .a files reproducibly buildable from
  rust/src (script exists, pinned toolchain/targets)? Is there any hash/CI
  check that they match the source? What happens when someone edits rust/src
  and forgets to rebuild?
- Arch coverage: android-rust has arm64-v8a and x86_64 only — missing
  armeabi-v7a/x86 implications; ios simulator arm64 vs x86_64; Mac Catalyst.
- Podspec: header search paths, static lib linking, new-arch flags, codegen
  modulesProvider wiring; will `pod install` work from a clean clone?
- Android: where's the JNI/CMake glue that consumes libreconcile_engine.a?
  If it lives in apps/sandbox/android rather than the package, the package is
  not self-contained — document exactly what a fresh consumer app must add.
- scripts/: rot, hardcoded paths, missing targets vs committed artifacts.
- Version/toolchain pins: rust edition/toolchain, RN version assumptions.

Return final message as ONLY a JSON array of findings, keys: file, line,
severity (critical|should-fix|noted), summary, failure_scenario, fix_sketch.
Empty array if none. For structural observations without a single line, use
line 1 of the most relevant file.
```

- [ ] **Step 2: Validate JSON as in Task 1 Step 2**

- [ ] **Step 3: Write to `<scratchpad>/audit-pass-packaging.json`**

---

### Task 6: Baseline evidence run

**Files (read-only):** none modified; commands only.

**Interfaces:**
- Consumes: nothing (can run in the first wave)
- Produces: `<scratchpad>/audit-baseline.txt` — raw output of the commands below, used by Task 7 verifiers as ground truth for "does the existing suite even pass?"

- [ ] **Step 1: Run the Rust checks and capture output**

Run: `cd packages/reconcile-engine/rust && cargo test 2>&1 | tail -30 && cargo clippy --all-targets 2>&1 | tail -40`
Expected: tests pass (record count); clippy warnings recorded verbatim (they are evidence, not findings by themselves).

- [ ] **Step 2: Run the JS tests and capture output**

Run: `cd packages/reconcile-engine && yarn test 2>&1 | tail -30`
Expected: jest suite result recorded.

- [ ] **Step 3: Append both outputs to `<scratchpad>/audit-baseline.txt`**

---

### Task 7: Adversarial verification of every finding

**Files (read-only):** whatever each finding points at.

**Interfaces:**
- Consumes: the five `audit-pass-*.json` files (Tasks 1–5) and `audit-baseline.txt` (Task 6). Blocked by all of them.
- Produces: `<scratchpad>/audit-verified.json` — array of findings with two added keys: `verdict` (`"CONFIRMED"` | `"PLAUSIBLE"` | `"REFUTED"`) and `verdict_reason` (string). REFUTED findings are retained in the file but excluded from the report.

- [ ] **Step 1: Merge the five pass files into one array; dedupe** — two findings are duplicates when they share `file` and overlapping line ranges and describe the same failure; keep the higher-severity copy.

- [ ] **Step 2: For each finding, dispatch a verifier subagent with exactly this prompt (parallel, one per finding)**

```text
Adversarially verify this claimed defect in packages/reconcile-engine — your
default stance is that it is WRONG. Read the cited code and enough surrounding
context to be sure. Claim: <finding JSON>.

Verdict rules:
- CONFIRMED: you can trace the exact failure path in the code (cite the lines)
  or demonstrate it with a read-only command (e.g. a targeted `cargo test`
  invocation of an existing test, `cargo check` type reasoning).
- PLAUSIBLE: you cannot refute it but also cannot fully trace it (e.g. depends
  on device runtime behavior).
- REFUTED: the claimed path cannot happen — cite the guard/line that prevents
  it.
Also re-grade severity per: critical = wrong data, data loss, UB, crash;
should-fix = footgun/design flaw; noted = nit.
Final message: ONLY a JSON object {"verdict": ..., "verdict_reason": ...,
"severity": ...}.
```

- [ ] **Step 3: Write the merged, verdict-annotated array to `<scratchpad>/audit-verified.json`**

---

### Task 8: Findings report

**Files:**
- Create: `docs/superpowers/audits/2026-07-19-engine-audit-findings.md`

**Interfaces:**
- Consumes: `audit-verified.json` (Task 7), `audit-baseline.txt` (Task 6). Blocked by both.
- Produces: the report the user reviews; its `## Critical` section becomes the input to the next plan (fixes).

- [ ] **Step 1: Write the report with exactly this structure**

```markdown
# Reconcile-Engine Audit Findings — 2026-07-19

Scope: full audit per docs/superpowers/specs/2026-07-19-engine-audit-and-real-db-rig-design.md (Phase 1).
Method: 5 specialist passes → dedupe → adversarial verification per finding.
Baseline: <one line: cargo test result, clippy warning count, jest result>.

## Critical (fix before rig)
### C1. <summary> — `<file>:<line>` [CONFIRMED|PLAUSIBLE]
**Failure:** <failure_scenario>
**Fix sketch:** <fix_sketch>
<repeat per critical>

## Should-fix
<same shape, S1..Sn>

## Noted
<one line each, N1..Nn: summary — file:line>

## Refuted during verification
<one line each: claim — why refuted> (kept for transparency)

## Coverage map
<table: layer × files read × pass that covered it — every file listed in the
spec's Phase 1 table must appear>
```

Severity placement uses the verifier's re-graded severity. PLAUSIBLE criticals stay critical (flagged) — durability defects don't get downgraded for being hard to prove statically.

- [ ] **Step 2: Self-check the report** — every spec Phase-1 file appears in the coverage map; no finding contradicts the spec's non-goals; every critical has CONFIRMED/PLAUSIBLE tag and fix sketch.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/audits/2026-07-19-engine-audit-findings.md
git commit -m "Add engine audit findings report"
```

- [ ] **Step 4: Present the report to the user** — summarize criticals in chat, link the file, and ask which criticals/should-fixes are approved for the fix plan. **STOP here; the fix plan is written only after that review.**
