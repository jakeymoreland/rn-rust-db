# Integrating the Reconcile Engine

How to wire `@rn-experiments/reconcile-engine` into a real stack: auth
(Better Auth), a server database (Postgres or Cloudflare D1), and the sync
loop between them.

## The mental model

The engine is the **on-device replica**. It owns local storage, conflict
resolution, change events, and a redis-style kv cache. It deliberately does
**no networking** — integration is always the same shape:

```
[ Postgres / D1 ]  ←  server API (delta endpoint + write endpoint)
        ↑↓
   fetch() in app  ←  Better Auth session token on every request
        ↓
  ingest(sourceId, payload)        ← engine reconciles (ts/priority, per field)
        ↓
  subscribe('changes:*') → re-query → UI (lazy zero-copy views)
```

Everything the server sends is just "a batch of rows with a natural key and
a timestamp". The engine's field-level (timestamp, priority) merge does the
rest, and re-sending unchanged data is free (whole-payload hash skip, plus
the per-row content-hash short-circuit).

## 1. Better Auth

Better Auth lives on your server; the app talks to it through its client SDK
(`better-auth/react` + the Expo plugin). The engine's job is only to hold
session-adjacent state and scope the data.

**Session storage** — keep tokens in SecureStore (Better Auth's Expo plugin
does this); mirror non-secret session facts into the engine kv so synchronous
code can read them at ~1 µs (note: `redis.expire`/`ttl` are in **milliseconds**,
and — matching Redis — `hset` preserves an existing key TTL; only `set` clears
it):

```ts
import { redis } from '@rn-experiments/reconcile-engine';

const { data: session } = await authClient.getSession();
await redis.set('auth:userId', session.user.id);
await redis.set('auth:sessionExpiresAt', String(session.session.expiresAt));
await redis.expire('auth:userId', msUntil(session.session.expiresAt));
```

**Authenticated sync** — every delta fetch carries the session cookie/token
the Better Auth client manages; the server filters rows to the user before
returning them. The engine never sees data the session can't.

**Sign-out** — clear kv keys and, for shared devices, wipe the whole replica
(the benchmark suite's wipe pattern: `closeEngine()`, delete the sqlite file
+ `-wal`/`-shm`, `openEngine()`, re-register sources).

## 2. The delta-sync contract (any backend)

Expose one endpoint per collection (or one multiplexed endpoint):

```
GET /sync/:collection?since=<cursor>&limit=1000
→ { rows: [...], cursor: "next-cursor", hasMore: boolean }
```

Endpoint requirements:

- Every row includes the **natural key field** and an **updated-at** value
  that only moves forward (server clock, not client).
- Order rows by `(updated_at, id)` and cursor on that pair — resumable and
  no rows skipped when timestamps collide.
- Use batches of 1,000–5,000 rows (measured: 1k rows reconcile in ~11 ms of
  engine time; payloads under ~1 MB cost at most one frame of JS time).

Client loop:

```ts
import { ingest, registerSource } from '@rn-experiments/reconcile-engine';

await registerSource({
  source_id: 'api',
  format: 'Json',
  collection: 'contacts',
  natural_key_field: 'id',
  timestamp_field: 'updated_at', // server timestamps drive conflict resolution
  priority: 10,
});

async function pull(collection: string) {
  let cursor = (await redis.get(`cursor:${collection}`)) ?? '';
  for (;;) {
    const res = await fetch(`${API}/sync/${collection}?since=${cursor}&limit=2000`, {
      headers: await authHeaders(),
    });
    const { rows, cursor: next, hasMore } = await res.json();
    if (rows.length) await ingest('api', JSON.stringify(rows));
    await redis.set(`cursor:${collection}`, (cursor = next));
    if (!hasMore) break;
  }
}
```

Transport guidance (from BENCHMARKS.md, measured on device): JSON strings are
fine below ~1 MB (5.4 ms/MB JS cost); when the response is already bytes,
pass them through (0.7 ms/MB); for very large pulls write the response to a
file and `ingestFile` (~zero JS cost).

**Deletes — current limitation.** The engine reconciles upserts only; it has no
tombstone handling yet. Until it does, use soft deletes end to end: the
server sets `deleted: "true"` + bumps `updated_at`, the row syncs like any
update, and queries/UI filter it out. Hard-purge locally on a schedule if
storage matters.

## 3. Local writes (device → server): the outbox

The engine is pull-authoritative: the server is the source of truth and the
device converges to it. For writes, use an outbox so offline works:

1. Apply the write **optimistically** through a second source with higher
   priority (`source_id: 'local'`, `priority: 20` beats `api` at 10 for the
   same timestamp) so the UI updates instantly.
2. Queue the mutation in kv: `redis.set('outbox:<uuid>', JSON.stringify(op))`.
3. A drain loop POSTs queued ops with the Better Auth session; on ack, delete
   the outbox key. The server's canonical row comes back on the next pull
   with a newer `updated_at` and wins cleanly.
4. On permanent rejection (validation, auth), move the op to an app-level
   dead-letter list and surface it — the same philosophy as the engine's
   ingest DLQ, one level up. The engine's own DLQ is now capped per source
   (newest 1000 kept) and drainable via the `deadLetterClear` command.

## 4. Postgres specifics

```sql
CREATE TABLE contacts (
  id          text PRIMARY KEY,
  -- ...fields...
  deleted     boolean NOT NULL DEFAULT false,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX contacts_sync ON contacts (updated_at, id);

CREATE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$ LANGUAGE plpgsql;
CREATE TRIGGER contacts_touch BEFORE UPDATE ON contacts
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
```

Delta query (cursor = `updated_at|id` of the last row served):

```sql
SELECT * FROM contacts
WHERE user_id = $1
  AND (updated_at, id) > ($2::timestamptz, $3)
ORDER BY updated_at, id
LIMIT $4;
```

Serialize timestamps as epoch millis or ISO-8601 (`YYYY-MM-DDTHH:MM:SSZ` and
offset/fractional forms are parsed to epoch ms). A `timestamp_field` that is
present but unparseable now **dead-letters the record** rather than silently
falling back to ingest time — so keep the format stable and valid. For
push-style freshness, LISTEN/NOTIFY → WebSocket → client runs `pull()` on nudge
(measured: 10-row ticks land on screen in ~14.5 ms median).

## 5. Cloudflare D1 specifics

D1 is SQLite at the edge, so it shares type affinity and comparison
semantics with the on-device store. A Worker
implements the same contract:

```ts
export default {
  async fetch(req: Request, env: Env) {
    const session = await auth.api.getSession({ headers: req.headers }); // Better Auth on Workers
    if (!session) return new Response('unauthorized', { status: 401 });

    const { searchParams } = new URL(req.url);
    const [since, sinceId] = (searchParams.get('since') ?? '0|').split('|');
    const rows = await env.DB.prepare(
      `SELECT * FROM contacts
       WHERE user_id = ?1 AND (updated_at > ?2 OR (updated_at = ?2 AND id > ?3))
       ORDER BY updated_at, id LIMIT 2000`,
    ).bind(session.user.id, Number(since), sinceId).all();

    const last = rows.results.at(-1);
    return Response.json({
      rows: rows.results,
      cursor: last ? `${last.updated_at}|${last.id}` : `${since}|${sinceId}`,
      hasMore: rows.results.length === 2000,
    });
  },
};
```

Notes: keep `updated_at` as INTEGER epoch millis in D1 (set it in the Worker
on every write — D1 has no triggers with clock authority you control);
Better Auth runs on Workers natively, so the same deployment can own auth
and sync; for live pushes, a Durable Object holding WebSockets per user
turns D1 writes into the tick pattern the benchmarks already validated.

## 6. Multi-source priorities

`priority` resolves same-timestamp conflicts per field. A working scheme:

| source_id | priority | role |
|---|---:|---|
| `csv` / bulk import | 5 | lowest — never beats live data |
| `api` (Postgres/D1) | 10 | canonical server state |
| `local` (optimistic) | 20 | wins until the server echoes it back newer |

## Known gaps to design around

- **No tombstones** — soft-delete pattern above until delete reconciliation
  exists.
- **Change events carry counts, not keys** — subscribers re-query the
  collection (cheap via the lazy zero-copy view, but the changed-keys event
  is the roadmap item that makes patching free).
- **No built-in scheduler** — pulls/drains are app-driven (foreground events,
  push nudges, or a timer). The whole-payload hash skip makes over-eager
  polling nearly free on the engine side.
