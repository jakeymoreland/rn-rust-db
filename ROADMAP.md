# Roadmap

Status of the reconcile engine and what's next. Items are grouped by theme, not
strictly ordered. Anything marked **blocker** stands between here and a clean
public/production release.

## Open-source readiness

- [x] **LICENSE file at repo root** (MIT, matching the podspec's declaration).
- [x] Root README and this roadmap.
- [x] **CI** (`.github/workflows/ci.yml`): `cargo test` + `cargo clippy`, engine
      `yarn test`, sandbox `tsc` + `yarn test`. Headless only (audit S47 closed).
- [ ] Native build job (macOS/Xcode + Android NDK) running the artifact
      drift-check — heavy, so scheduled/opt-in rather than per-PR. Pairs with the
      artifact-distribution decision below.
- [x] `CONTRIBUTING.md`.
- [x] Issue/PR templates (`.github/`).
- [x] `SECURITY.md` — private reporting via GitHub advisories. **Requires
      "Private vulnerability reporting" to be enabled in repo settings**;
      until it is, the advisory link 404s and reporters fall back to email.
- [ ] Decide artifact distribution: commit prebuilt `.a`/xcframework via git-lfs,
      or a published-package build flow. They are gitignored today and built
      locally by `scripts/build-*.sh`.

## Packaging & DX

- [ ] **blocker — Android self-containment (audit S29).** The package has no
      `android/` gradle library, so a consumer must hand-wire CMake, `OnLoad.cpp`,
      app-level codegen, and ABI config themselves. Give it a real gradle library
      so autolinking works from `npm install`. This is the main thing stopping
      someone else from just using it.
- [ ] Mac Catalyst slice in the xcframework (currently unsupported; documented).
- [ ] Track `OnLoad.cpp` / codegen against React Native internals on RN upgrades
      (audit F56) — add the divergence-check the README describes.

## Engine semantics (known gaps)

- [ ] **Delete / tombstone reconciliation.** Today deletes are soft-delete +
      filter only. Real tombstone handling would remove the app-level workaround.
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

- [ ] **Reduce max JS-thread gap on very large ingests.** A single ~95 MB / 100k
      ingest blocks the JS thread ~388 ms. Chunked/streamed ingest guidance
      exists (batches of 1–5k), but engine-side chunking or a background-thread
      ingest option would remove the footgun.
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
