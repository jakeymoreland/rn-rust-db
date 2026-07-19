import { mockNative } from './rn-mock';
import {
  openEngine,
  redis,
  ingest,
  registerSource,
  subscribe,
  subscribeWithCleanup,
  EngineError,
} from '../index';

const okResp = (value: unknown) => JSON.stringify({ ok: true, value });
const errResp = (code: number, message: string) =>
  JSON.stringify({ ok: false, code, message });

beforeEach(() => {
  jest.clearAllMocks();
  mockNative.onChange.listeners = [];
});

test('openEngine calls native open', async () => {
  await openEngine('/tmp/db.sqlite');
  expect(mockNative.open).toHaveBeenCalledWith('/tmp/db.sqlite');
});

test('redis.get sends envelope and unwraps value', async () => {
  mockNative.execute.mockResolvedValue(okResp('1'));
  const v = await redis.get('a');
  expect(mockNative.execute).toHaveBeenCalledWith(
    JSON.stringify({ cmd: 'get', args: ['a'] }),
  );
  expect(v).toBe('1');
});

test('error envelope becomes typed Error', async () => {
  mockNative.execute.mockResolvedValue(errResp(4, "unknown command 'x'"));
  await expect(redis.get('a')).rejects.toThrow("unknown command 'x'");
  await expect(redis.get('a')).rejects.toMatchObject({ code: 4 });
});

test('ingest parses BatchSummary via the direct method', async () => {
  mockNative.ingestDirect.mockResolvedValue(
    okResp({ inserted: 2, updated: 0, unchanged: 0, dead_lettered: 1, collections: ['people'], skipped: false }),
  );
  const s = await ingest('api', '[...]');
  expect(mockNative.ingestDirect).toHaveBeenCalledWith('api', '[...]');
  expect(s.inserted).toBe(2);
  expect(s.collections).toEqual(['people']);
});

test('registerSource serializes config as single arg', async () => {
  mockNative.execute.mockResolvedValue(okResp('OK'));
  await registerSource({
    source_id: 'api', format: 'Json', collection: 'people',
    natural_key_field: 'email', timestamp_field: null, priority: 10,
  });
  const sent = JSON.parse(mockNative.execute.mock.calls[0][0]);
  expect(sent.cmd).toBe('registerSource');
  expect(JSON.parse(sent.args[0]).source_id).toBe('api');
});

test('subscribe routes matching channels and unsubscribes', async () => {
  mockNative.execute.mockResolvedValue(okResp(1));
  const seen: string[] = [];
  const unsub = await subscribe('changes:*', (channel) => seen.push(channel));
  mockNative.onChange.emit({ channel: 'changes:people', payload: '{"inserted":1}' });
  mockNative.onChange.emit({ channel: 'other:thing', payload: '{}' });
  expect(seen).toEqual(['changes:people']);
  unsub();
  mockNative.onChange.emit({ channel: 'changes:people', payload: '{}' });
  expect(seen).toEqual(['changes:people']);
});

// Audit S18: a throwing handler must not escape into the emitter dispatch; it
// goes to onError, and sibling subscriptions keep working.
test('throwing handler is routed to onError and does not break siblings', async () => {
  mockNative.execute.mockResolvedValue(okResp(1));
  const errors: unknown[] = [];
  const sibling: string[] = [];
  await subscribe('changes:*', () => { throw new Error('boom'); }, (e) => errors.push(e));
  await subscribe('changes:*', (ch) => sibling.push(ch));
  expect(() =>
    mockNative.onChange.emit({ channel: 'changes:people', payload: '{}' }),
  ).not.toThrow();
  expect(errors).toHaveLength(1);
  expect(sibling).toEqual(['changes:people']);
});

// Audit S18: a non-JSON payload goes to onError instead of throwing.
test('non-JSON payload is routed to onError', async () => {
  mockNative.execute.mockResolvedValue(okResp(1));
  const errors: unknown[] = [];
  await subscribe('changes:*', () => {}, (e) => errors.push(e));
  mockNative.onChange.emit({ channel: 'changes:people', payload: 'not json' });
  expect(errors).toHaveLength(1);
});

// Audit S19: unsubscribe after closeEngine must not produce an unhandled
// rejection, and calling it twice sends the native unsubscribe only once.
test('unsubscribe is idempotent and swallows rejection', async () => {
  mockNative.execute.mockResolvedValueOnce(okResp(7)); // subscribe
  const unsub = await subscribe('changes:*', () => {});
  mockNative.execute.mockReset();
  mockNative.execute.mockRejectedValue(new Error('engine not open'));
  let unhandled: unknown;
  const onUnhandled = (e: unknown) => (unhandled = e);
  process.on('unhandledRejection', onUnhandled);
  unsub();
  unsub(); // second call must be a no-op
  await new Promise((r) => setTimeout(r, 10));
  process.off('unhandledRejection', onUnhandled);
  expect(mockNative.execute).toHaveBeenCalledTimes(1); // only one native unsubscribe
  expect(unhandled).toBeUndefined();
});

// Audit S24: cancelling before the async subscribe resolves must still
// unsubscribe (no leaked listener) once it resolves.
test('subscribeWithCleanup cancels a still-pending subscription', async () => {
  let resolveSub!: (v: string) => void;
  mockNative.execute.mockReturnValueOnce(new Promise((r) => (resolveSub = r)));
  const seen: string[] = [];
  const cancel = subscribeWithCleanup('changes:*', (ch) => seen.push(ch));
  cancel(); // unmount before subscribe resolves
  mockNative.execute.mockResolvedValue(okResp(true)); // the deferred unsubscribe
  resolveSub(okResp(1)); // subscription now resolves
  await new Promise((r) => setTimeout(r, 10));
  // the listener must have been removed, so no events are delivered
  mockNative.onChange.emit({ channel: 'changes:people', payload: '{}' });
  expect(seen).toEqual([]);
});

// Audit F36: openEngine surfaces a tagged native error as an EngineError.
test('openEngine rethrows a tagged native error as EngineError', async () => {
  mockNative.open.mockImplementationOnce(() => {
    throw new Error('EngineError:2:disk is full');
  });
  const err = await openEngine('/bad/path').catch((e) => e);
  expect(err).toBeInstanceOf(EngineError);
  expect(err).toMatchObject({ code: 2, message: 'disk is full' });
});

test('openEngine wraps an untagged native error generically', async () => {
  mockNative.open.mockImplementationOnce(() => {
    throw new Error('some native failure');
  });
  const err = await openEngine('/bad/path').catch((e) => e);
  expect(err).toBeInstanceOf(EngineError);
  expect(err).toMatchObject({ code: 0, message: 'some native failure' });
});
