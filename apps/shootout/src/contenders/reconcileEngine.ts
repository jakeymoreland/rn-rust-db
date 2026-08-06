// The reconcile engine, entered on the same terms as everyone else.
//
// Worth being explicit about the handicap it carries here, because it cuts
// both ways: an `insert` through this engine is not an INSERT. It parses the
// payload, normalizes it, content-hashes it, merges field by field against
// whatever is already stored (resolving by timestamp then source priority),
// and then writes. Nothing else in this shootout does that.
//
// That means a loss on raw insert latency is not necessarily a loss — and a
// win would be a strong result. Either way the report prints the extra work
// alongside the number so a reader can judge it.
import {
  closeEngine,
  fastPath,
  ingest,
  installFastPath,
  openEngine,
  registerSource,
} from '@rn-experiments/reconcile-engine';
import { Paths } from 'expo-file-system';
import type { Contender, Row } from '../contender';
import { decodeEntriesBuffer, decodeSchemaBuffer } from '../decode';

const COLLECTION = 'messages';
let dbPath = '';

async function wipe() {
  try {
    closeEngine();
  } catch {
    // not open yet
  }
  const { File } = await import('expo-file-system');
  for (const suffix of ['', '-wal', '-shm']) {
    const f = new File(`file://${dbPath}${suffix}`);
    if (f.exists) f.delete();
  }
}

export const reconcileEngine: Contender = {
  name: '@rn-experiments/reconcile-engine',
  configuration: 'Rust core + SQLite WAL, synchronous=NORMAL, JSI',
  durability: 'app-crash',
  caveats: [
    'an insert here also parses, normalizes, content-hashes and field-level merges against stored state — the others do a plain insert',
    'reads use the zero-copy buffer path, fully decoded to JS objects so the comparison matches getAllAsync',
  ],

  async setup() {
    dbPath = `${Paths.document.uri.replace(/^file:\/\//, '')}/shootout-engine.sqlite`;
    await wipe();
    await openEngine(dbPath);
    await registerSource({
      source_id: 'bench',
      format: 'Json',
      collection: COLLECTION,
      natural_key_field: 'id',
      timestamp_field: null,
      priority: 1,
    });
    // The JSI query functions are opt-in — installFastPath() is what puts them
    // on globalThis. The sandbox app does this once at startup, which is why
    // this was easy to miss here.
    if (!installFastPath()) throw new Error('installFastPath() returned false');
    if (!fastPath()) throw new Error('fast path did not install');
  },

  async teardown() {
    await wipe();
  },

  async insertOne(row: Row) {
    await ingest('bench', JSON.stringify([row]));
  },

  async insertMany(rows: Row[]) {
    await ingest('bench', JSON.stringify(rows));
  },

  async readAll() {
    // MUST decode to usable JS objects. An earlier version of this returned the
    // row count straight off the buffer header without materializing anything,
    // and "read all" then measured a u32 read against getAllAsync building
    // 10,000 objects — a 24x result that was entirely the harness cheating in
    // our favour. The contract is usable rows, so decode them.
    const fp = fastPath();
    if (!fp) throw new Error('fast path not installed');
    const rows = decodeEntriesBuffer(fp.queryEntriesBuffer(COLLECTION));
    return rows.length;
  },

  async readPage(limit: number, offset: number) {
    const fp = fastPath();
    if (!fp) throw new Error('fast path not installed');
    const rows = decodeSchemaBuffer(
      fp.queryEntriesSchemaBufferRange(COLLECTION, 'id,sender,body,sent_at,read', limit, offset),
    );
    return rows.length;
  },

  async updateSome(rows: Row[]) {
    await ingest('bench', JSON.stringify(rows.map((r) => ({ id: r.id, read: !r.read }))));
  },
};
