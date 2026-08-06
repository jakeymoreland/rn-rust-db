// WatermelonDB: the genuinely fair rival.
//
// Free, React Native native, SQLite-backed, same platform, same JS<->native
// boundary. Where RxDB's SQLite storage is a paid Premium plugin (the bundled
// free one caps at 500 documents and has no indexes), this is a like-for-like
// comparison a reader can actually run.
//
// Configured with JSI enabled, which is WatermelonDB at its best — synchronous
// native calls rather than the async bridge. Anything less would be
// benchmarking a handicap we chose for it.
import { Database, Model, appSchema, tableSchema } from '@nozbe/watermelondb';
import SQLiteAdapter from '@nozbe/watermelondb/adapters/sqlite';
import type { Contender, Row } from '../contender';

// Deliberately no @field/@text decorators.
//
// They are a typing and ergonomics convenience in WatermelonDB — the storage
// and query work underneath is identical either way — and getting them through
// Babel cost three separate build failures: a plugin/core major-version
// mismatch, a plugin-ordering trap that broke every `declare` field in
// node_modules, and finally `!` definite-assignment clashing with the decorator
// transform. Raw accessors avoid all of it, need no babel plugin, and if
// anything favour WatermelonDB slightly by skipping the accessor indirection.
class Message extends Model {
  static table = 'messages';
}

type RawSettable = Model & { _setRaw(field: string, value: string | number | boolean | null): void };
type RawGettable = Model & { _getRaw(field: string): unknown };

function setRow(m: Model, row: Row) {
  const r = m as RawSettable;
  m._raw.id = row.id;
  r._setRaw('sender', row.sender);
  r._setRaw('body', row.body);
  r._setRaw('sent_at', row.sent_at);
  r._setRaw('read', row.read);
}

const schema = appSchema({
  version: 1,
  tables: [
    tableSchema({
      name: 'messages',
      columns: [
        { name: 'sender', type: 'string' },
        { name: 'body', type: 'string' },
        { name: 'sent_at', type: 'string' },
        { name: 'read', type: 'boolean' },
      ],
    }),
  ],
});

let db: Database | null = null;
/** Which adapter path actually initialised, reported in the results. */
let adapterMode = 'unknown';

function messages() {
  return db!.get<Message>('messages');
}

export const watermelon: Contender = {
  name: '@nozbe/watermelondb',
  configuration: 'SQLite via JSI adapter, schema-validated models',
  durability: 'app-crash',
  caveats: [
    'writes go through a schema-validated model layer and its batching API, which the raw SQLite contender does not have',
    'SQLite pragmas are the adapter default — not explicitly matched to the other contenders',
  ],

  async setup() {
    await this.teardown();
    // Prefer JSI — synchronous native calls, WatermelonDB at its fastest. It is
    // not available on every platform/version combination (iOS reported
    // "Cannot read property 'initializeJSI' of null" here), so fall back to the
    // async bridge adapter rather than scoring the library as a failure. Which
    // path was used is reported alongside the numbers, because it materially
    // changes them.
    const make = (jsi: boolean) =>
      new SQLiteAdapter({
        schema,
        dbName: 'shootout_wmdb',
        jsi,
        onSetUpError: (e) => {
          throw e;
        },
      });

    let adapter;
    try {
      adapter = make(true);
      adapterMode = 'JSI';
    } catch {
      adapter = make(false);
      adapterMode = 'async bridge (JSI unavailable)';
    }

    db = new Database({ adapter, modelClasses: [Message] });
    try {
      await db.write(async () => {
        await db!.unsafeResetDatabase();
      });
    } catch (e) {
      // A JSI adapter that constructs but cannot actually run shows up here.
      if (adapterMode === 'JSI') {
        adapterMode = 'async bridge (JSI failed at first write)';
        db = new Database({ adapter: make(false), modelClasses: [Message] });
        await db.write(async () => {
          await db!.unsafeResetDatabase();
        });
      } else {
        throw e;
      }
    }
    this.configuration = `SQLite via ${adapterMode}, schema-validated models`;
  },

  async teardown() {
    if (db) {
      try {
        await db.write(async () => {
          await db!.unsafeResetDatabase();
        });
      } catch {
        // already gone
      }
      db = null;
    }
  },

  async insertOne(row: Row) {
    await db!.write(async () => {
      await messages().create((m) => setRow(m, row));
    });
  },

  async insertMany(rows: Row[]) {
    // batch() is WatermelonDB's documented bulk path — one native call for the
    // whole set, which is the fair equivalent of a chunked multi-row INSERT.
    await db!.write(async () => {
      await db!.batch(
        rows.map((row) =>
          messages().prepareCreate((m) => setRow(m, row)),
        ),
      );
    });
  },

  async readAll() {
    const all = await messages().query().fetch();
    // Touch a field so the comparison includes materializing usable values,
    // matching what the other contenders are made to do.
    let seen = 0;
    for (const m of all) if ((m as RawGettable)._getRaw('sender')) seen++;
    return seen;
  },

  async readPage(limit: number, offset: number) {
    const { Q } = await import('@nozbe/watermelondb');
    const page = await messages()
      .query(Q.skip(offset), Q.take(limit))
      .fetch();
    let seen = 0;
    for (const m of page) if ((m as RawGettable)._getRaw('sender')) seen++;
    return seen;
  },

  async updateSome(rows: Row[]) {
    const { Q } = await import('@nozbe/watermelondb');
    await db!.write(async () => {
      // Fetch only the records being updated. Fetching the whole table to build
      // the id map would fold a full read into this contender's update number,
      // which nothing else here does.
      const found = await messages()
        .query(Q.where('id', Q.oneOf(rows.map((r) => r.id))))
        .fetch();
      const byId = new Map(found.map((m) => [m.id, m]));
      const updates = rows
        .map((r) => byId.get(r.id))
        .filter((m): m is Message => !!m)
        .map((m) =>
          m.prepareUpdate((rec) => {
            const r = rec as RawSettable & RawGettable;
            r._setRaw('read', !r._getRaw('read'));
          }),
        );
      await db!.batch(updates);
    });
  },
};
