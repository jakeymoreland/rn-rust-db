import NativeReconcileEngine from './NativeReconcileEngine';
import { globMatch } from './glob';

export type SourceConfig = {
  source_id: string;
  format: 'Json' | 'Csv';
  collection: string;
  natural_key_field: string;
  timestamp_field: string | null;
  priority: number;
  /**
   * When true, each batch is this source's full set of keys. Keys it omits
   * become tombstones at the batch's version and compete with other sources
   * through the same order as an update. Default false: a partial batch never
   * deletes rows that simply were not in it.
   */
  snapshot?: boolean;
};

export type IngestTimings = {
  parse_ms: number;
  prefetch_ms: number;
  merge_ms: number;
  write_ms: number;
  commit_ms: number;
};

export type BatchSummary = {
  inserted: number;
  updated: number;
  unchanged: number;
  dead_lettered: number;
  collections: string[];
  skipped?: boolean;
  timings?: IngestTimings;
  /**
   * Natural keys that visibly changed, grouped by collection — so a subscriber
   * can re-read just those rows instead of re-querying the collection.
   *
   * Absent when nothing changed. Capped at 1024 keys per collection; when the
   * cap is hit {@link BatchSummary.keys_truncated} is set and the list is a
   * prefix, so fall back to a full re-query.
   *
   * On a change event this is scoped to the event's own collection (see
   * {@link ChangeEvent.collection}).
   */
  changed_keys?: Record<string, string[]>;
  /** Set when any key list was capped — the change set is incomplete. */
  keys_truncated?: boolean;
  /** Keys that moved from visible to hidden because a tombstone won. */
  deleted?: number;
  /** Source timestamps clamped to the local clock plus the skew bound. */
  clock_clamped?: number;
};

/**
 * A change event payload: the batch summary, plus which collection this event
 * is for and the keys that changed in it.
 *
 * The patched pattern — read only `changed_keys` and merge them into existing
 * state — is what keeps a live list at 60 fps; re-querying the whole collection
 * per tick measured 1.8 fps on the same load.
 */
export type ChangeEvent = BatchSummary & {
  collection: string;
  changed_keys: Record<string, string[]>;
};

export class EngineError extends Error {
  constructor(public code: number, message: string) {
    super(message);
    this.name = 'EngineError';
  }
}

function unwrap<T>(responseJson: string): T {
  const resp = JSON.parse(responseJson);
  if (!resp.ok) throw new EngineError(resp.code, resp.message);
  return resp.value as T;
}

async function call<T>(cmd: string, args: string[]): Promise<T> {
  return unwrap<T>(await NativeReconcileEngine.execute(JSON.stringify({ cmd, args })));
}

/**
 * Opens the engine at `path` and installs the host functions (`ingestAppend`,
 * paged query, the sync measurement hook).
 *
 * The native `open` itself is synchronous: SQLite open and WAL setup run on
 * the JS thread before this resolves. It is `async` only so open errors
 * surface as a rejection. Open failures reject with an {@link EngineError}.
 *
 * Installing the host functions is part of open, not a second step. Without
 * them `ingest()` has to pass the whole payload through as a string, which is
 * the path that blocked the JS thread for hundreds of milliseconds.
 */
export async function openEngine(path: string): Promise<void> {
  try {
    NativeReconcileEngine.open(path);
    NativeReconcileEngine.installFastPath();
  } catch (e) {
    throw toEngineError(e);
  }
}

/**
 * Parses the native error-envelope conventions into an {@link EngineError}:
 * either a bare `EngineError:<code>:<message>` string (the open/reject path) or
 * a JSON envelope. Falls back to a generic EngineError so callers can always
 * rely on `.code` and `instanceof EngineError`.
 */
function toEngineError(e: unknown): EngineError {
  if (e instanceof EngineError) return e;
  const msg = e instanceof Error ? e.message : String(e);
  const tagged = /EngineError:(\d+):([\s\S]*)$/.exec(msg);
  if (tagged) return new EngineError(Number(tagged[1]), tagged[2]);
  try {
    const parsed = JSON.parse(msg);
    if (parsed && typeof parsed.code === 'number') {
      return new EngineError(parsed.code, String(parsed.message ?? msg));
    }
  } catch {
    // not JSON — fall through
  }
  return new EngineError(0, msg);
}

export function closeEngine(): void {
  NativeReconcileEngine.close();
}

export const redis = {
  get: (key: string) => call<string | null>('get', [key]),
  set: (key: string, value: string) => call<'OK'>('set', [key, value]),
  del: (key: string) => call<boolean>('del', [key]),
  mget: (...keys: string[]) => call<Array<string | null>>('mget', keys),
  scan: (pattern: string) => call<string[]>('scan', [pattern]),
  hget: (key: string, field: string) => call<string | null>('hget', [key, field]),
  hset: (key: string, field: string, value: string) => call<'OK'>('hset', [key, field, value]),
  hgetall: (key: string) => call<Record<string, string>>('hgetall', [key]),
  /**
   * Batch `hgetall`: one call for many keys, results in the order given, with
   * an empty object for a miss so callers can zip positionally.
   *
   * Prefer this over looping `hgetall`. Each single call is a separate JSI
   * crossing, and 100 sequential ones measured ~5 s under concurrent write
   * load on both iOS and Android — enough to consume an entire 5-second
   * benchmark window on its own. `entry:` keys are grouped per collection into
   * one query engine-side.
   */
  hmgetall: (...keys: string[]) => call<Array<Record<string, string>>>('hmgetall', keys),
  /**
   * Sets a TTL in MILLISECONDS (not seconds like Redis EXPIRE). `ttlMs` must be
   * positive. Rejects with an {@link EngineError} (code 4) if the key does not
   * exist — unlike Redis EXPIRE, which returns 0. Wrap in try/catch for
   * best-effort expiry.
   */
  expire: (key: string, ttlMs: number) => call<'OK'>('expire', [key, String(ttlMs)]),
  /**
   * Remaining TTL in milliseconds, or `null` when the key has no TTL OR does
   * not exist (the two Redis sentinels -1 and -2 are not distinguished).
   */
  ttl: (key: string) => call<number | null>('ttl', [key]),
};

export function registerSource(cfg: SourceConfig): Promise<void> {
  return call<'OK'>('registerSource', [JSON.stringify(cfg)]).then(() => undefined);
}

export function ingest(sourceId: string, payload: string): Promise<BatchSummary> {
  // Once the fast path is installed, the payload is sliced and each slice is
  // copied on its own turn. The engine runs on the native worker when the
  // last slice arrives, so the JS thread is not inside std::string conversion
  // of the whole payload or inside ingestBufferSync. Without the fast path
  // (tests, or a caller that has not installed it) the direct string method
  // remains.
  const fp = fastPath();
  if (fp?.ingestAppend) {
    return ingestChunked(sourceId, payload);
  }
  return NativeReconcileEngine.ingestDirect(sourceId, payload).then(unwrap<BatchSummary>);
}

export function ingestFile(sourceId: string, path: string): Promise<BatchSummary> {
  return call<BatchSummary>('ingestFile', [sourceId, path]);
}

export async function subscribe(
  pattern: string,
  handler: (channel: string, summary: BatchSummary) => void,
  onError: (err: unknown) => void = (err) => console.error('subscribe handler error', err),
): Promise<() => void> {
  const id = await call<number>('subscribe', [pattern]);
  const sub = NativeReconcileEngine.onChange((e) => {
    // Audit S18: never let a bad payload or a throwing handler escape into the
    // native event-emitter dispatch (an uncaught global error in RN). Match
    // with the same glob semantics as the native matcher (audit S17).
    if (!globMatch(pattern, e.channel)) return;
    try {
      handler(e.channel, JSON.parse(e.payload));
    } catch (err) {
      onError(err);
    }
  });
  // Audit S19: idempotent, and the fire-and-forget native unsubscribe can't
  // surface as an unhandled rejection (e.g. after closeEngine).
  let done = false;
  return () => {
    if (done) return;
    done = true;
    sub.remove();
    void call<boolean>('unsubscribe', [String(id)]).catch(() => {});
  };
}

/**
 * Subscribe helper that is safe against an unmount racing the async subscribe
 * resolution (audit S24). Call the returned function to cancel: if subscription
 * has already resolved it unsubscribes; if it is still pending it unsubscribes
 * as soon as it resolves, so no listener leaks.
 */
export function subscribeWithCleanup(
  pattern: string,
  handler: (channel: string, summary: BatchSummary) => void,
  onError?: (err: unknown) => void,
): () => void {
  let unsub: (() => void) | undefined;
  let cancelled = false;
  subscribe(pattern, handler, onError).then(
    (u) => {
      if (cancelled) u();
      else unsub = u;
    },
    (err) => (onError ?? ((e) => console.error('subscribe failed', e)))(err),
  );
  return () => {
    cancelled = true;
    unsub?.();
  };
}

export function executeRaw(requestJson: string): Promise<string> {
  return NativeReconcileEngine.execute(requestJson);
}

/**
 * Synchronous, JS-thread-blocking execute. **Use sparingly.** It runs on the
 * calling (JS) thread and contends on the engine mutex, so if the worker is
 * mid-way through a long ingest it can block the UI thread for the entire
 * ingest. Intended for benchmarks and tiny reads where the async round-trip
 * overhead dominates — prefer {@link executeRaw} everywhere else.
 */
export function executeRawSync(requestJson: string): string {
  return NativeReconcileEngine.executeSync(requestJson);
}

export function installFastPath(): boolean {
  return NativeReconcileEngine.installFastPath();
}

/**
 * Synchronous JSI query functions, installed by {@link installFastPath}.
 *
 * **Read `queryPage` first.** It is the only query here whose cost is roughly
 * independent of collection size, and it is what a list UI should use. Measured
 * on an iPhone 16 Pro over a 10,000-row collection:
 *
 * | call | ms |
 * |---|---|
 * | `queryPage` (50 rows) | **3.6** |
 * | `queryBuffer` + lazy view | 7.2 |
 * | `queryObjects` (all rows) | 39.8 |
 * | `querySchemaObjects` (all rows) | **245.2** |
 *
 * Every one of these runs on the JS thread for its full duration, so anything
 * above the ~16.7 ms frame budget drops frames no matter how fast the engine is.
 */
export type FastPathQueries = {
  /**
   * One page of rows as a packed buffer — the windowed path. Cost tracks the
   * page size, not the collection size, so this stays in frame budget whether
   * the collection holds a thousand rows or a hundred thousand.
   */
  queryEntriesSchemaBufferRange(
    collection: string,
    fieldsCsv: string,
    limit: number,
    offset: number,
  ): ArrayBuffer;
  /**
   * The whole collection as one zero-copy buffer, to be read lazily so only the
   * rows actually touched become JS objects. Reasonable for a list that
   * materialises a visible window; see `queryEntriesSchemaBufferRange` when you
   * only ever need a page.
   */
  queryEntriesBuffer(collection: string): ArrayBuffer;
  /**
   * @deprecated Materialises **every row** of the collection into JS objects on
   * the JS thread — 245 ms for 10,000 rows, ~67x the windowed page, and it grows
   * linearly from there. Use `queryEntriesSchemaBufferRange` for a page, or
   * `queryEntriesBuffer` with a lazy view if you genuinely need the whole set.
   */
  queryEntriesSchemaBuffer(collection: string, fieldsCsv: string): ArrayBuffer;
  /**
   * @deprecated Builds a JS object per row for the entire collection — 39.8 ms
   * for 10,000 rows against 7.2 ms for the buffer path, and the gap widens with
   * size. Prefer `queryEntriesBuffer`.
   */
  queryEntriesObjects(collection: string): unknown[];
  kvGet(key: string): string | null;
  kvSet(key: string, value: string): void;
  /**
   * Append one slice of an ingest. `final` runs the engine on the native
   * worker and resolves to the response envelope. Earlier slices resolve to
   * the string `"null"`.
   */
  ingestAppend(
    streamId: string,
    sourceId: string,
    chunk: ArrayBuffer,
    finalChunk: boolean,
  ): Promise<string>;
  /**
   * One page of a schema buffer, built on the reader worker. The ArrayBuffer
   * is the Rust allocation (zero-copy). Cost on the JS thread is adopting
   * the pointer, not the query.
   */
  queryPageAsync(
    collection: string,
    fieldsCsv: string,
    limit: number,
    offset: number,
  ): Promise<ArrayBuffer>;
};

/**
 * The installed fast-path functions, or `null` when {@link installFastPath} has
 * not been called (or returned false).
 */
export function fastPath(): FastPathQueries | null {
  return (globalThis as { __reconcileEngine?: FastPathQueries }).__reconcileEngine ?? null;
}

/** Characters (or bytes, for a Uint8Array) copied on one JS turn. */
const INGEST_CHUNK = 256 * 1024;
let ingestStreamSeq = 0;

function yieldTurn(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

/**
 * Ingest `payload` without holding the JS thread for the whole body.
 *
 * A string is sliced on UTF-16 code-unit boundaries that do not split a
 * surrogate pair, encoded per slice, and appended. A Uint8Array is sliced
 * as bytes. The native worker concatenates the slices and runs the ingest
 * when the last one arrives. Between slices a macrotask is scheduled so a
 * 16 ms timer can run; that is the max-gap the device bench measures.
 */
export async function ingestChunked(
  sourceId: string,
  payload: string | Uint8Array,
): Promise<BatchSummary> {
  const fp = fastPath();
  if (!fp?.ingestAppend) {
    if (typeof payload !== 'string') {
      throw new EngineError(4, 'installFastPath() is required to ingest bytes');
    }
    return NativeReconcileEngine.ingestDirect(sourceId, payload).then(unwrap<BatchSummary>);
  }
  const id = String(++ingestStreamSeq);
  const total = typeof payload === 'string' ? payload.length : payload.byteLength;
  if (total === 0) {
    return unwrap<BatchSummary>(await fp.ingestAppend(id, sourceId, new ArrayBuffer(0), true));
  }
  let last = '';
  let off = 0;
  while (off < total) {
    let end = Math.min(off + INGEST_CHUNK, total);
    if (typeof payload === 'string' && end < total) {
      const lead = payload.charCodeAt(end - 1);
      if (lead >= 0xd800 && lead <= 0xdbff) {
        end += 1;
      }
    }
    const finalChunk = end >= total;
    let ab: ArrayBuffer;
    if (typeof payload === 'string') {
      const encoded = new TextEncoder().encode(payload.slice(off, end));
      ab = encoded.buffer.slice(
        encoded.byteOffset,
        encoded.byteOffset + encoded.byteLength,
      ) as ArrayBuffer;
    } else {
      const slice = payload.subarray(off, end);
      ab = slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength) as ArrayBuffer;
    }
    last = await fp.ingestAppend(id, sourceId, ab, finalChunk);
    off = end;
    if (!finalChunk) {
      await yieldTurn();
    }
  }
  return unwrap<BatchSummary>(last);
}

/** Row count from a schema-buffer page. A short page ends a stream. */
export function schemaBufferRowCount(buf: ArrayBuffer): number {
  const view = new DataView(buf);
  if (buf.byteLength < 8) {
    return 0;
  }
  let off = 0;
  const nFields = view.getUint32(off, true);
  off += 4;
  for (let i = 0; i < nFields; i++) {
    if (off + 4 > buf.byteLength) {
      return 0;
    }
    const len = view.getUint32(off, true);
    off += 4 + len;
  }
  if (off + 4 > buf.byteLength) {
    return 0;
  }
  return view.getUint32(off, true);
}

export async function queryPageAsync(
  collection: string,
  fieldsCsv: string,
  limit: number,
  offset: number,
): Promise<ArrayBuffer> {
  const fp = fastPath();
  if (!fp?.queryPageAsync) {
    throw new EngineError(4, 'installFastPath() is required for queryPageAsync');
  }
  return fp.queryPageAsync(collection, fieldsCsv, limit, offset);
}

/**
 * Walk a collection one page at a time. Each page is a zero-copy buffer
 * produced on the reader worker. The callback sees it before the next page
 * is requested, so only one page is live.
 */
export async function forEachPage(
  collection: string,
  fieldsCsv: string,
  pageSize: number,
  onPage: (page: ArrayBuffer, offset: number) => void | Promise<void>,
): Promise<number> {
  let offset = 0;
  let pages = 0;
  for (;;) {
    const buf = await queryPageAsync(collection, fieldsCsv, pageSize, offset);
    const n = schemaBufferRowCount(buf);
    if (n === 0) {
      break;
    }
    await onPage(buf, offset);
    pages += 1;
    if (n < pageSize) {
      break;
    }
    offset += n;
  }
  return pages;
}
