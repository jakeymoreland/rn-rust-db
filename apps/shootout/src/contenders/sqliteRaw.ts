// Bare expo-sqlite: the floor.
//
// This is the most informative contender in the set. It is SQLite on the same
// device, through the same platform, with no engine on top — so the gap between
// it and any other contender is exactly what that library's abstraction costs.
// If our reconcile engine is close to this, the Rust pipeline is nearly free;
// if it is far above, the pipeline is where the time goes.
//
// Configured to match our engine's defaults exactly (WAL, synchronous=NORMAL),
// because comparing at different durability levels is the mistake this whole
// app exists to avoid.
import * as SQLite from 'expo-sqlite';
import type { Contender, Row } from '../contender';

const DB = 'shootout-raw.db';

let db: SQLite.SQLiteDatabase | null = null;

export const sqliteRaw: Contender = {
  name: 'expo-sqlite (raw)',
  configuration: 'SQLite WAL, synchronous=NORMAL, prepared statements',
  durability: 'app-crash',
  caveats: [
    'no schema validation, no reactivity, no conflict resolution — this is the floor, not a product',
  ],

  async setup() {
    await this.teardown();
    db = await SQLite.openDatabaseAsync(DB);
    // Same pragmas the reconcile engine sets, so the comparison is like for like.
    await db.execAsync(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA temp_store = MEMORY;
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY NOT NULL,
        sender TEXT NOT NULL,
        body TEXT NOT NULL,
        sent_at TEXT NOT NULL,
        read INTEGER NOT NULL
      );
      DELETE FROM messages;
    `);
  },

  async teardown() {
    if (db) {
      await db.closeAsync();
      db = null;
    }
    await SQLite.deleteDatabaseAsync(DB).catch(() => {});
  },

  async insertOne(row: Row) {
    await db!.runAsync(
      'INSERT OR REPLACE INTO messages (id, sender, body, sent_at, read) VALUES (?, ?, ?, ?, ?)',
      [row.id, row.sender, row.body, row.sent_at, row.read ? 1 : 0],
    );
  },

  async insertMany(rows: Row[]) {
    // One transaction, one prepared statement — the fastest honest way to do
    // this in expo-sqlite, which is what the floor should represent.
    const stmt = await db!.prepareAsync(
      'INSERT OR REPLACE INTO messages (id, sender, body, sent_at, read) VALUES (?, ?, ?, ?, ?)',
    );
    try {
      await db!.execAsync('BEGIN');
      for (const r of rows) {
        await stmt.executeAsync([r.id, r.sender, r.body, r.sent_at, r.read ? 1 : 0]);
      }
      await db!.execAsync('COMMIT');
    } catch (e) {
      await db!.execAsync('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      await stmt.finalizeAsync();
    }
  },

  async readAll() {
    const rows = await db!.getAllAsync<Row>('SELECT * FROM messages');
    return rows.length;
  },

  async readPage(limit: number, offset: number) {
    const rows = await db!.getAllAsync<Row>(
      'SELECT * FROM messages ORDER BY id LIMIT ? OFFSET ?',
      [limit, offset],
    );
    return rows.length;
  },

  async updateSome(rows: Row[]) {
    const stmt = await db!.prepareAsync('UPDATE messages SET read = ? WHERE id = ?');
    try {
      await db!.execAsync('BEGIN');
      for (const r of rows) {
        await stmt.executeAsync([r.read ? 0 : 1, r.id]);
      }
      await db!.execAsync('COMMIT');
    } finally {
      await stmt.finalizeAsync();
    }
  },
};
