import { mockNative } from './rn-mock';
import { openEngine, redis, ingest, registerSource, subscribe } from '../index';

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
