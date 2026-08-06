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

/**
 * Hermes has no `crypto`, and RxDB needs `getRandomValues` for document
 * revisions and instance tokens — without it, createRxDatabase throws
 * `ReferenceError: Property 'crypto' doesn't exist`.
 *
 * This is a Math.random shim, NOT a secure source of randomness. That is
 * acceptable here and nowhere else: the benchmark needs distinct ids, not
 * unpredictable ones. A real app would install react-native-get-random-values,
 * which is a native module and would require a rebuild — deliberately avoided
 * so this contender needs nothing beyond a JS reload.
 */
function ensureCrypto() {
  const g = globalThis as { crypto?: { getRandomValues?: unknown } };
  if (g.crypto?.getRandomValues) return;
  const getRandomValues = <T extends ArrayBufferView | null>(array: T): T => {
    if (array && ArrayBuffer.isView(array)) {
      const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
      for (let i = 0; i < bytes.length; i++) bytes[i] = (Math.random() * 256) | 0;
    }
    return array;
  };
  if (g.crypto) {
    (g.crypto as { getRandomValues: typeof getRandomValues }).getRandomValues = getRandomValues;
  } else {
    g.crypto = { getRandomValues };
  }
}

/**
 * RxDB hashes document revisions with `crypto.subtle.digest` (SHA-256), which
 * Hermes does not provide either — it throws UT8. RxDB documents the escape
 * hatch: "If your JavaScript runtime does not support crypto.subtle.digest,
 * provide your own hash function when calling createRxDatabase()."
 *
 * This is a 64-bit FNV-1a, not SHA-256. Note this is *generous* to RxDB rather
 * than a handicap: a pure-JS SHA-256 would be considerably slower per document
 * than this is, so its write numbers here are better than a real Hermes app
 * without a native crypto module would see. Collision risk over 10k documents
 * with a 64-bit digest is negligible for a benchmark.
 */
async function fnv1a64(input: string | ArrayBuffer | Blob): Promise<string> {
  // RxDB may hand this a string, an ArrayBuffer, or a Blob. Only strings occur
  // in these scenarios; the others fall back to their string form so the
  // function is total rather than silently wrong for an input we never hit.
  const text =
    typeof input === 'string'
      ? input
      : input instanceof ArrayBuffer
        ? String.fromCharCode(...new Uint8Array(input))
        : String(input);
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x85ebca6b) >>> 0;
  }
  return (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0'));
}

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
    'Hermes provides neither crypto.getRandomValues nor crypto.subtle.digest; a Math.random shim and an FNV-1a hashFunction stand in. Both are benchmark-only and not secure — and the hash is faster than the SHA-256 RxDB would normally use, so this favours RxDB slightly',
  ],

  async setup() {
    ensureCrypto();
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
      hashFunction: fnv1a64,
      multiInstance: false,
      eventReduce: false,
      // No `ignoreDuplicate: true`: RxDB only permits it in dev mode and
      // otherwise throws DB9, whose stored message is stale PouchDB-era advice
      // ("Adapter not added. Use addPouchPlugin(...)") that has nothing to do
      // with the actual check. A unique database name per scenario makes the
      // flag unnecessary anyway.
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
