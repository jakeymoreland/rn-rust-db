# Roadmap

Status of the reconcile engine and what's next. Items are grouped by theme, not
strictly ordered. Anything marked **blocker** stands between here and a clean
public/production release.

## Open-source readiness

- [x] **LICENSE file at repo root** (MIT, matching the podspec's declaration).
- [x] Root README and this roadmap.
- [x] **CI** (`.github/workflows/ci.yml`): `cargo test` + `cargo clippy`, engine
      `yarn test`, sandbox `tsc` + `yarn test`. Headless only (audit S47 closed).
- [x] Native build job. CI builds all four Android ABIs and the iOS
      xcframework on every pull request and uploads them as workflow artifacts.
      Rust tests, clippy, and the boundary bench run in the same workflow.
- [x] `CONTRIBUTING.md`.
- [x] Issue/PR templates (`.github/`).
- [x] `SECURITY.md` — private reporting via GitHub advisories. **Requires
      "Private vulnerability reporting" to be enabled in repo settings**;
      until it is, the advisory link 404s and reporters fall back to email.
- [ ] Decide artifact distribution for consumers who are not on CI: commit
      prebuilt `.a`/xcframework via git-lfs, or publish them from the workflow
      artifacts. They are still gitignored and built locally by
      `scripts/build-*.sh`. CI proves they build; it does not yet attach them
      to a release.

## Packaging & DX

- [x] **Android self-containment (audit S29).** The package now ships an
      `android/` gradle library plus a `react-native.config.js` declaring the C++
      module, so autolinking compiles the TurboModule and links the Rust static
      lib into the app's `libappmodules.so` on its own. Consumer apps need no
      CMake, no `OnLoad.cpp`, and no codegen task — `apps/sandbox/android` has
      none of them any more. See the package README.
- [ ] Mac Catalyst slice in the xcframework (currently unsupported; documented).
- [x] Track `OnLoad.cpp` / codegen against React Native internals on RN upgrades
      (audit F56) — moot: the copied `OnLoad.cpp` and the `generate-codegen-artifacts.js`
      shell-out are gone, replaced by RN's own default app setup and the gradle
      plugin's library codegen. The remaining RN-shaped surface is the three
      autolinking keys in `react-native.config.js`, which are public API.

## Engine semantics (known gaps)

- [x] **Delete / tombstone reconciliation.** `"_deleted": true` and opt-in
      `snapshot: true` both write a tombstone that competes with updates on the
      same version order. Queries hide the row. Compaction drops tombstones
      older than the retention window.
- [ ] **Changed-keys in change events.** Events carry counts, not keys, so
      subscribers re-query. Emitting the changed keys makes patching free.
- [ ] **Atomic `INCR`/`DECR` kv commands.** Counters are whole-value `set` today
      (compute in JS). An atomic increment primitive would suit high-frequency
      counter workloads (e.g. reaction counters).
- [ ] **Full Redis glob** (`?` and `[...]` classes). Only `*` is supported;
      other metacharacters match literally (audit-deferred).
- [ ] Built-in sync scheduler. Pulls/drains are app-driven by design; a built-in
      option is a convenience, not a gap — revisit only if demand appears.

## Performance

- [x] **Reduce max JS-thread gap on very large ingests.** `ingest()` slices the
      payload (256 KB) once `installFastPath()` has run, and the engine runs on
      the native worker. `queryPageAsync` / `forEachPage` do the same for
      reads and keep the zero-copy buffer. The synchronous `ingestBufferSync`
      hook remains for measurement. The on-device 388 ms figure is the old
      string path; the host boundary bench is in `BENCHMARKS.md`. A fresh
      device pass of the chunked path is still worth taking.
- [ ] **Cold-start hydrate.** ~2.5 s to make 100k rows queryable after reopen;
      worth profiling for a faster warm path.
- [ ] Evaluate columnar / FlatBuffers-style storage for known schemas. The
      schema-buffer format already avoids per-row JSON; the remaining cost is
      string decode. Measure whether typed/columnar access is worth the storage
      change before committing.
- [ ] Evaluate `HostObject` for the large-object marshaling path (measure first
      — it does not help small windows, which the lazy view already covers).

## Testing & benchmarks

- [ ] **Sustained-load benchmark** — 10k–50k ingest + repeated queries +
      UI-driven materialization in a loop over time, to catch degradation the
      single-shot benchmarks miss.
- [ ] **Thermal / power benchmark** — a 30–60 s continuous run, on a *physical
      device* (simulator does not throttle), to observe sustained-write throttling.
- [ ] **Memory-growth tracking** — sample RSS / JS heap across repeated bulk
      ingest + flush cycles to confirm the read-cache and dead-letter caps
      (audit S12/F24) hold under sustained pressure.
- [ ] **Real process-kill reliability test.** The current crash check is an
      in-process proxy (close/reopen); a true process-kill test would harden the
      durability claims.
