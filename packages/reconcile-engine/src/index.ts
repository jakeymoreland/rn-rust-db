import NativeReconcileEngine from './NativeReconcileEngine';

export type SourceConfig = {
  source_id: string;
  format: 'Json' | 'Csv';
  collection: string;
  natural_key_field: string;
  timestamp_field: string | null;
  priority: number;
};

export type BatchSummary = {
  inserted: number;
  updated: number;
  unchanged: number;
  dead_lettered: number;
  collections: string[];
  skipped?: boolean;
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

export async function openEngine(path: string): Promise<void> {
  NativeReconcileEngine.open(path);
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
  expire: (key: string, ttlMs: number) => call<'OK'>('expire', [key, String(ttlMs)]),
  ttl: (key: string) => call<number | null>('ttl', [key]),
};

export function registerSource(cfg: SourceConfig): Promise<void> {
  return call<'OK'>('registerSource', [JSON.stringify(cfg)]).then(() => undefined);
}

export function ingest(sourceId: string, payload: string): Promise<BatchSummary> {
  return call<BatchSummary>('ingest', [sourceId, payload]);
}

export function ingestFile(sourceId: string, path: string): Promise<BatchSummary> {
  return call<BatchSummary>('ingestFile', [sourceId, path]);
}

function globToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

export async function subscribe(
  pattern: string,
  handler: (channel: string, summary: BatchSummary) => void,
): Promise<() => void> {
  const id = await call<number>('subscribe', [pattern]);
  const re = globToRegex(pattern);
  const sub = NativeReconcileEngine.onChange.addListener((e) => {
    if (re.test(e.channel)) handler(e.channel, JSON.parse(e.payload));
  });
  return () => {
    sub.remove();
    void call<boolean>('unsubscribe', [String(id)]);
  };
}

export function executeRaw(requestJson: string): Promise<string> {
  return NativeReconcileEngine.execute(requestJson);
}

export function executeRawSync(requestJson: string): string {
  return NativeReconcileEngine.executeSync(requestJson);
}

export function installFastPath(): boolean {
  return NativeReconcileEngine.installFastPath();
}
