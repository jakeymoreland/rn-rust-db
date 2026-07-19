# Engine Audit + Real-DB Hardening Rig

**Date:** 2026-07-19
**Goal:** Harden `@rn-experiments/reconcile-engine` for real product use by (1) fully
auditing the existing code, (2) fixing critical defects with regression tests, and
(3) proving the engine against a production-shaped stack — real Postgres, real
Better Auth, real device loop — via an explicit caveat matrix.

**Explicit non-goals (decided):** no new engine features. The three known gaps —
delete/tombstone reconciliation, changed-keys change events, built-in sync
scheduler — stay app-level workarounds as documented in `docs/INTEGRATIONS.md`.
Cloudflare D1 backend is out of scope (contract stays backend-agnostic; D1 can be
added later without rig redesign).

## Phase 1 — Full audit

Scope: every layer of `packages/reconcile-engine` (~3,600 lines).

| Layer | Files | Audit emphasis |
|---|---|---|
| TS API | `src/index.ts`, `src/NativeReconcileEngine.ts` | contract soundness, error paths, subscription lifecycle, double-parse costs |
| Rust core | `rust/src/*.rs` (12 modules) | `ffi.rs` unsafety & panic-across-FFI, `reconcile.rs` merge semantics & edge cases, `store.rs` durability/transactions, `pubsub.rs` races, `dispatch.rs`/`commands.rs` input validation |
| C++ glue | `cpp/NativeReconcileEngine.{h,cpp}` | JSI lifetime/thread-safety, fast-path host functions, event emitter delivery, ArrayBuffer ownership |
| Native packaging | podspec, codegen config, `ios/`, `android-rust/`, `ios-rust/`, `scripts/` | committed static libs vs source drift, arch coverage, build reproducibility |
| Tests/docs | `src/__tests__`, `rust/tests`, BENCHMARKS.md claims | coverage gaps, claims not backed by tests |

Method: parallel specialist review passes (memory-safety/FFI, merge-correctness,
durability, API-contract, packaging), each finding verified against the code
before being reported.

Deliverable: a triaged findings report presented to the user **before any fix
lands**:

- **Critical** — correctness, durability, or soundness defects. Will be fixed.
- **Should-fix** — design flaws and footguns. Fixed opportunistically when cheap.
- **Noted** — nits and deferrals. Logged only.

## Phase 2 — Fix criticals

For each approved critical: write a failing regression test first (cargo test or
jest, whichever layer owns the defect), then fix, then verify. No fixes before the
user has reviewed the findings report.

## Phase 3 — The rig

### Server (`apps/server`, new workspace)

- Node + **Hono**, real **Better Auth** (email/password), `pg` against Postgres
  run via a `docker-compose.yml` in `apps/server`.
- Implements the delta-sync contract exactly as `docs/INTEGRATIONS.md` §2/§4:
  `GET /sync/:collection?since=<cursor>&limit=N` with `(updated_at, id)` cursor
  pairs, `timestamptz` + touch triggers, rows scoped to the session user, and a
  write endpoint for outbox drain.
- Auth realism includes the failure paths: 401 mid-sync, expired session,
  sign-out → replica wipe.

### Schema & seed (synthetic realistic domain)

Collections: `contacts`, `conversations`, `messages`, `orders`.
Seed generator (~100k rows total) deliberately covers: per-user scoping, wide and
narrow rows, nulls, unicode, hot rows churned on a timer (server-side updater),
and a CSV bulk-import source registered at priority 5 to exercise multi-source
merge (`csv` 5 / `api` 10 / `local` 20, per INTEGRATIONS.md §6).

### Headless layer

Rust integration tests in `rust/tests/` drive the engine crate directly against
the live server over HTTP. Fast, CI-able coverage of merge, cursor, durability,
and replay caveats.

### Device layer

A Sync screen in `apps/sandbox` runs the full production loop: Better Auth
sign-in (Expo client, SecureStore sessions, kv mirroring), pull loop with cursor
in kv, optimistic outbox writes + drain, `subscribe → re-query → LegendList`.
**Full caveat suite runs on both iOS simulator and Android emulator.**

## Phase 4 — Caveat matrix

Results live in `docs/CAVEATS.md`: scenario × expected behavior × observed result
× pass/fail, per platform where relevant. Scenarios:

1. Clock skew between device and server; timestamps that move backward.
2. Same-timestamp conflicts resolved by source priority, per field.
3. Out-of-order, duplicate, and replayed batches (idempotency).
4. Cursor resumption across app restarts and server restarts mid-pull.
5. Process kill mid-ingest → reopen integrity (real kill, not in-process proxy).
6. Corrupted payloads → dead-letter behavior and recovery.
7. 401/expired session mid-sync; sign-out replica wipe and re-hydrate.
8. Offline outbox: queue, drain, retry, server echo convergence, permanent
   rejection → app-level dead letter.
9. Schema drift: server adds fields, renames fields, changes a field's type.
10. Natural-key collisions and key reuse.
11. Soft-delete filtering correctness and cost at scale (the documented
    tombstone workaround, proven under load).
12. Sustained hot-row churn with the UI live (frame drops, event latency).

Any failed scenario feeds back into Phase 2 treatment (regression test → fix),
or — if it reveals a workaround that cannot work — gets documented as a hard
caveat in INTEGRATIONS.md.

## Success criteria

- Audit report delivered and reviewed; all approved criticals fixed with
  regression tests passing.
- `docker compose up` + one command brings up seeded Postgres + server.
- Headless suite green in CI-able form (`cargo test`).
- Caveat matrix complete on both platforms with every scenario either **pass**
  or a documented, user-acknowledged caveat.
