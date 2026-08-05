---
name: Feature request
about: Propose a capability or a change to engine semantics
title: ''
labels: enhancement
assignees: ''
---

## The problem

<!-- The use case, not the solution. What are you trying to build that the
     engine makes hard or impossible today? -->

## Already on the roadmap?

Please check [ROADMAP.md](https://github.com/jakeymoreland/rn-rust-db/blob/main/ROADMAP.md)
first — known gaps like tombstone
reconciliation, changed-keys in change events, atomic kv `INCR`/`DECR`, full
Redis glob, and Android autolinking are already tracked. If yours is there, a
comment on the existing issue (or a note about your use case) is more useful
than a new request.

## Proposed shape

<!-- If you have an API in mind, sketch it. Which layer would it live in —
     Rust core, TS API, or both? -->

## Constraints worth knowing

- The engine deliberately **does no networking**; sync loops belong in the host
  app. Proposals that put transport inside the engine are out of scope.
- Anything on the ingest/query hot path needs a benchmark story — see
  [BENCHMARKS.md](https://github.com/jakeymoreland/rn-rust-db/blob/main/BENCHMARKS.md).
