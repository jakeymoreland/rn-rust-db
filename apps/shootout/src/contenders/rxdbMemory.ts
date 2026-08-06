// RxDB, on the only storage it can legally and practically run here.
//
// Its SQLite RxStorage is a paid Premium plugin. The version bundled with core
// is trial-gated — the shipped package itself says "500 documents." and points
// at "premium SQLite storage to remove these limits" — so it cannot complete a
// 1,000 or 10,000 row scenario at all. The remaining free storages are Dexie
// (IndexedDB, browser), localstorage, and memory.
//
// So this contender runs on memory storage, and its numbers must be read with
// `durability: 'none'` attached. It is not persistence: nothing here survives
// the process exiting. Printing that next to the number is the whole reason the
// Contender interface makes durability a required field — a fast number from an
// in-memory store and a fast number from a durable one are not the same claim,
// and the confusion between them is what started this benchmark project.
import { addRxPlugin, createRxDatabase, type RxCollection, type RxDatabase } from 'rxdb';
import { getRxStorageMemory } from 'rxdb/plugins/storage-memory';
import { RxDBQueryBuilderPlugin } from 'rxdb/plugins/query-builder';
import type { Contender, Row } from '../contender';

let pluginsAdded = false;

const messageSchema = {
  version: 0,
  primaryKey: 'id',
  type: 'object',
  properties: {
    id: { type: 'string', maxLength: 64 },
    sender: { type: 'string' },
    body: { type: 'string' },
    sent_at: { type: 'string' },
    read: { type: 'boolean' },
  },
  required: ['id', 'sender', 'body', 'sent_at', 'read'],
} as const;

let db: RxDatabase | null = null;
let messages: RxCollection | null = null;
let dbSeq = 0;

export const rxdbMemory: Contender = {
  name: 'RxDB (memory storage)',
  configuration: 'rxdb memory RxStorage — in-process, not persisted',
  durability: 'none',
  caveats: [
    'NOT a persistence comparison: memory storage survives nothing, so its write numbers are not comparable to the SQLite-backed contenders',
    'RxDB’s SQLite RxStorage is a paid Premium plugin; the bundled free build is capped at 500 documents, which cannot complete the 1k/10k scenarios here',
    'documents are schema-validated JSON, not SQL rows',
  ],

  async setup() {
    if (!pluginsAdded) {
      addRxPlugin(RxDBQueryBuilderPlugin);
      pluginsAdded = true;
    }
    await this.teardown();
    // A fresh database name each time: RxDB caches instances by name, and
    // reusing one across scenarios would carry state between them.
    db = await createRxDatabase({
      name: `shootout_rxdb_${dbSeq++}`,
      storage: getRxStorageMemory(),
      multiInstance: false,
      ignoreDuplicate: true,
      eventReduce: false,
    });
    const cols = await db.addCollections({ messages: { schema: messageSchema } });
    messages = cols.messages;
  },

  async teardown() {
    if (db) {
      try {
        await db.remove();
      } catch {
        try {
          await db.close();
        } catch {
          // already gone
        }
      }
      db = null;
      messages = null;
    }
  },

  async insertOne(row: Row) {
    await messages!.insert(row);
  },

  async insertMany(rows: Row[]) {
    // bulkInsert is RxDB's documented bulk path — one call for the whole set,
    // the fair equivalent of a chunked multi-row INSERT.
    const res = await messages!.bulkInsert(rows);
    if (res.error.length) {
      throw new Error(`bulkInsert reported ${res.error.length} errors`);
    }
  },

  async readAll() {
    const docs = await messages!.find().exec();
    // Touch a field so the comparison includes materializing usable values,
    // matching what the other contenders are made to do.
    let seen = 0;
    for (const d of docs) if (d.get('sender')) seen++;
    return seen;
  },

  async readPage(limit: number, offset: number) {
    const docs = await messages!.find({ sort: [{ id: 'asc' }], skip: offset, limit }).exec();
    let seen = 0;
    for (const d of docs) if (d.get('sender')) seen++;
    return seen;
  },

  async updateSome(rows: Row[]) {
    await messages!.bulkUpsert(rows.map((r) => ({ ...r, read: !r.read })));
  },
};
