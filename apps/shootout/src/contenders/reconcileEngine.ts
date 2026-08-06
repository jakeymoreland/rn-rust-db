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
    'reads use the zero-copy buffer path, decoded lazily in JS',
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
    // hgetall over every key would be the naive path; the engine's own advice
    // is one buffer over the boundary, so that is what it is measured on.
    const fp = fastPath();
    if (!fp) throw new Error('fast path not installed');
    const buf = fp.queryEntriesBuffer(COLLECTION);
    const view = new DataView(buf);
    return view.byteLength > 0 ? view.getUint32(0, true) : 0;
  },

  async readPage(limit: number, offset: number) {
    const fp = fastPath();
    if (!fp) throw new Error('fast path not installed');
    const buf = fp.queryEntriesSchemaBufferRange(
      COLLECTION,
      'id,sender,body,sent_at,read',
      limit,
      offset,
    );
    const view = new DataView(buf);
    return view.byteLength > 0 ? view.getUint32(0, true) : 0;
  },

  async updateSome(rows: Row[]) {
    await ingest('bench', JSON.stringify(rows.map((r) => ({ id: r.id, read: !r.read }))));
  },
};
