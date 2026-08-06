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
| **@nozbe/watermelondb** | working — read numbers are cache-warm, see below |
| **RxDB (memory storage)** | working; memory only — see below for why |

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

### WatermelonDB: works — and a correction

An earlier version of this README claimed WatermelonDB 0.28.0 could not run
under React Native's New Architecture, based on:

```
NativeModules.WMDatabaseBridge is not defined!
```

**That claim was wrong and has been retracted.** WatermelonDB runs fine here
under Expo SDK 57 / RN 0.86 with `newArchEnabled: true`, on the iOS simulator.

The real cause was local and unglamorous: the app process had been launched
before the WatermelonDB pod was in the binary, and every subsequent attempt
reloaded *JavaScript* against that same stale native binary. A JS reload cannot
add a native module. A full terminate-and-relaunch fixed it immediately.

Recorded here because the diagnosis was confidently wrong in a way that
maligned another project, and because the symptom is easy to misread: the error
names linking, the pod genuinely is linked, and the natural next suspicion —
New Architecture support — was plausible enough to survive several checks that
all confirmed the *linking* was fine while never testing a cold start.

If you hit this, cold-start the app before concluding anything about the
library.

**Caveat on its read numbers.** WatermelonDB keeps an in-memory record cache.
The read scenarios run in the same session that inserted the rows, so its
`read all` is served largely from that cache rather than from SQLite — which is
why it comes back several times faster than every other contender. That is a
real advantage in a long-lived app and a misleading one for a cold read, so it
is called out rather than presented as a like-for-like storage read.

### RxDB: memory storage, because that is the only free option that fits

RxDB's SQLite RxStorage is a **paid Premium plugin**. This is not inferred from
the docs, which contradict themselves on it — it is in the shipped package.
`rxdb@17.4.0`'s bundled `storage-sqlite` contains the strings `500 documents.`,
`premium SQLite RxStorage:` and `premium SQLite storage to remove these limits:`.
A 500-document cap cannot complete a 1,000 or 10,000 row scenario.

The remaining free storages are Dexie (IndexedDB, browser), localstorage, and
memory. So this contender runs on **memory**, and carries `durability: 'none'`.

That means its write numbers are not a persistence comparison and must never be
read as one. It is in the table anyway, because a fast number from a store that
writes nothing to disk sitting next to a durable one — with the durability
column between them — makes the point better than a paragraph does.

The practical conclusion for anyone quoting RxDB figures on React Native: a free
configuration is either in-memory, browser-only, or capped at 500 documents.
Including the "5–16 ms single insert" figure quoted in this project's earlier
material, which is RxDB's published **browser** suite (LokiJS/PouchDB/Dexie) and
was never a React Native measurement. It should not have been presented as a
head-to-head; this app exists partly to replace it with one.

## Durability

Comparing databases without stating what each was configured for is not
comparing them. On an iPhone 16 Pro, one pragma apart:

| | ms/insert | survives |
|---|---:|---|
| `synchronous=NORMAL` | 0.29 | app crash |
| `synchronous=FULL` + `fullfsync=ON` | 4.30 | power loss |

A **14.8x** spread. Any cross-database number that does not say which side of
that line it sits on is meaningless. See `BENCHMARKS.md` in the repo root.
