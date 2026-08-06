# RN database shootout

A head-to-head between on-device databases for React Native, run on one device,
in one run, through one harness. `@rn-experiments/reconcile-engine` is one
contender among several and gets no special treatment.

It exists because every unfair benchmark this project has published came from an
uncontrolled variable: a parser measured against a database write, a browser
suite quoted against native SQLite, a harness timing its own `await`. So a
contender must declare its configuration, what a write has survived by the time
the call resolves, and its caveats — and all three print next to every number.

Where a library cannot do something, it returns `null` and the report shows a
gap rather than substituting a cheaper operation.

## Running it

```bash
yarn install                      # from the repo root
cd apps/shootout
npx expo run:ios                  # or run:android
```

Tap **Run shootout**. Results render on screen, copy as markdown, and (in dev)
log to Metro.

## Contenders

| | status |
|---|---|
| **expo-sqlite (raw)** | working — the floor |
| **@rn-experiments/reconcile-engine** | working |
| **@nozbe/watermelondb** | **blocked, see below** |
| RxDB | not yet attempted, see below |

### expo-sqlite is the floor, and that is the point

Bare SQLite with the same pragmas as the engine (WAL, `synchronous=NORMAL`), no
abstraction. The gap between it and any other contender is exactly what that
library's abstraction costs on that device. It is the most informative number
in the set and needs no third party to produce.

It is given its best shape, not its most idiomatic one: bulk work uses chunked
multi-row `INSERT`s rather than a prepared statement executed per row. The
per-row version costs one JS→native crossing per row, and benchmarking that
against an engine that sends one payload across the boundary measures the
bridge rather than SQLite. That correction alone moved a result from 7.3x to
2.3x.

### WatermelonDB: blocked by the New Architecture

Not a benchmark result — it could not be run at all.

```
NativeModules.WMDatabaseBridge is not defined! This means that you haven't
properly linked WatermelonDB native module.
```

The message is misleading here. It **is** linked. Verified on both slices:

- `pod install` reports `Auto-linking React Native modules for target shootout: ReconcileEngine, WatermelonDB, and simdjson`
- `WatermelonDB` and `simdjson` appear in `Podfile.lock`
- `WMDatabaseBridge.o` is compiled for both `Debug-iphonesimulator` and
  `Debug-iphoneos`
- `OTHER_LDFLAGS` contains `-ObjC`, so this is not a static-library constructor
  being stripped

It compiles and links, and the legacy `NativeModules` entry is simply absent at
runtime under bridgeless mode. That matches WatermelonDB's own open issue
[#1969](https://github.com/Nozbe/WatermelonDB/issues/1969) ("Current support
status for React Native New Architecture / Expo SDK 54+") and
[#1769](https://github.com/Nozbe/WatermelonDB/issues/1769) ("Bridgeless Mode
support"). A bridgeless fix was merged in
[#1875](https://github.com/Nozbe/WatermelonDB/pull/1875) and 0.28.0 postdates
it, so whatever remains is narrower than "no support at all".

Scope of the claim, precisely: **@nozbe/watermelondb 0.28.0 does not register
its native module under Expo SDK 57 / React Native 0.86 with
`newArchEnabled: true`, on iOS simulator and device.** That is the only
configuration tested. It says nothing about the old architecture, Android, or
other SDK versions.

This cannot be worked around by disabling the New Architecture, because the
reconcile engine is a C++ TurboModule and requires it. In this configuration the
two cannot coexist in one app — which is itself worth knowing if you are
choosing between them.

Getting this far cost five build failures, all recorded in git history and
worth knowing if you attempt it: a decorators plugin major-version mismatch
against Babel core, a plugin-ordering trap that broke every `declare` field in
`node_modules`, `!` definite-assignment clashing with the decorator transform,
and a JSI adapter that constructs but cannot run. The contender now uses raw
accessors and needs no Babel plugin at all.

### RxDB: what a fair comparison would even mean

Not yet attempted, and the shape of it is constrained before any code is
written. RxDB's SQLite storage is a **paid Premium plugin**; the version bundled
with core is, per their docs, "not made for production", has no indexes, and is
"limited to store 500 non-deleted documents" — unusable at the 1k/10k row sizes
here.

Their recommended free React Native path is the Expo Filesystem storage, which
their own documentation says outperforms their SQLite storage. So a free,
reproducible RxDB comparison means Expo Filesystem, not SQLite, and that must be
stated next to any number.

Note also that the "5–16 ms single insert" figure quoted in this project's
earlier material is RxDB's published **browser** suite (LokiJS/PouchDB/Dexie),
not React Native native SQLite. It should never have been presented as a
head-to-head, and this app exists partly to replace it with one.

## Durability

Comparing databases without stating what each was configured for is not
comparing them. On an iPhone 16 Pro, one pragma apart:

| | ms/insert | survives |
|---|---:|---|
| `synchronous=NORMAL` | 0.29 | app crash |
| `synchronous=FULL` + `fullfsync=ON` | 4.30 | power loss |

A **14.8x** spread. Any cross-database number that does not say which side of
that line it sits on is meaningless. See `BENCHMARKS.md` in the repo root.
