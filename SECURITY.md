# Security Policy

## Supported versions

This project is pre-1.0 and experimental. Only the current `main` is supported —
there are no maintained release branches, and fixes land on `main` rather than
being backported.

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Report privately through GitHub: go to the
[Security tab](https://github.com/jakeymoreland/rn-rust-db/security/advisories/new)
and open a draft advisory. If that is unavailable to you, email
jake@initialstudios.com.au instead.

Please include the affected component (Rust core, C++/JSI bridge, TypeScript
API, or build scripts), the platform, and a minimal reproduction if you have
one. Expect an acknowledgement within a week; this is a solo-maintained side
project, so please be patient with fix timelines.

## Scope notes

Some things are known, documented properties rather than vulnerabilities:

- **The engine does no networking**, by design. Anything to do with transport
  security, auth tokens, or server trust lives in the host app — see
  [docs/INTEGRATIONS.md](./docs/INTEGRATIONS.md).
- **The store is not encrypted.** SQLite data sits in the app's container with
  whatever protection the OS and the host app's data-protection settings give
  it. If you need encryption at rest, that is a host-app concern today.
- **The C ABI trusts its caller.** `packages/reconcile-engine/cpp/include/engine.h`
  documents the pointer/lifetime contract; passing invalid handles or freeing
  buffers twice is caller error, not an engine bug.

Memory-safety failures in the Rust core, panics that cross the FFI boundary,
SQL injection through the command surface, and buffer-length errors in the
zero-copy encode/decode path are all in scope and worth reporting.
