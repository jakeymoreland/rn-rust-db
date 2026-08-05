import NativeReconcileEngine from './NativeReconcileEngine';
import { globMatch } from './glob';

export type SourceConfig = {
  source_id: string;
  format: 'Json' | 'Csv';
  collection: string;
  natural_key_field: string;
  timestamp_field: string | null;
  priority: number;
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
 * Opens the engine at `path`.
 *
 * NOTE: despite the async signature, the underlying native `open` is
 * synchronous and runs the SQLite open + WAL setup on the JS thread before this
 * resolves (~tens of ms cold). It is `async` only so open errors surface as a
 * rejection. Open failures reject with an {@link EngineError} carrying the
 * native code and message.
 */
export async function openEngine(path: string): Promise<void> {
  try {
    NativeReconcileEngine.open(path);
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
  // Direct method: the payload crosses the boundary as a plain string instead
  // of being JSON-escaped into a command envelope and parsed twice.
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
