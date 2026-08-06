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
  configuration: 'SQLite WAL, synchronous=NORMAL, chunked multi-row INSERT',
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
    // Chunked multi-row INSERT, not a prepared statement executed per row.
    //
    // This matters for fairness. The per-row version is the idiomatic
    // expo-sqlite shape, but it costs one JS->native round trip per row — 1000
    // rows means 1000 crossings, and benchmarking that against an engine which
    // sends one payload across the boundary measures the bridge, not SQLite.
    // A performance-minded developer writing raw expo-sqlite would batch, so
    // the floor is represented batching.
    //
    // 100 rows x 5 columns = 500 bound parameters, comfortably under SQLite's
    // 999-variable default limit.
    const CHUNK = 100;
    await db!.execAsync('BEGIN');
    try {
      for (let i = 0; i < rows.length; i += CHUNK) {
        const slice = rows.slice(i, i + CHUNK);
        const placeholders = slice.map(() => '(?, ?, ?, ?, ?)').join(',');
        const params: (string | number)[] = [];
        for (const r of slice) {
          params.push(r.id, r.sender, r.body, r.sent_at, r.read ? 1 : 0);
        }
        await db!.runAsync(
          `INSERT OR REPLACE INTO messages (id, sender, body, sent_at, read) VALUES ${placeholders}`,
          params,
        );
      }
      await db!.execAsync('COMMIT');
    } catch (e) {
      await db!.execAsync('ROLLBACK').catch(() => {});
      throw e;
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
    // Batched like insertMany, and for the same reason: a prepared statement
    // executed per row costs one bridge crossing per row, which measures the
    // boundary rather than SQLite. A VALUES list joined against the table does
    // the whole chunk in one statement.
    const CHUNK = 100;
    await db!.execAsync('BEGIN');
    try {
      for (let i = 0; i < rows.length; i += CHUNK) {
        const slice = rows.slice(i, i + CHUNK);
        const values = slice.map(() => '(?, ?)').join(',');
        const params: (string | number)[] = [];
        for (const r of slice) params.push(r.id, r.read ? 0 : 1);
        await db!.runAsync(
          `WITH v(id, read) AS (VALUES ${values})
           UPDATE messages SET read = (SELECT v.read FROM v WHERE v.id = messages.id)
           WHERE id IN (SELECT id FROM v)`,
          params,
        );
      }
      await db!.execAsync('COMMIT');
    } catch (e) {
      await db!.execAsync('ROLLBACK').catch(() => {});
      throw e;
    }
  },
};
