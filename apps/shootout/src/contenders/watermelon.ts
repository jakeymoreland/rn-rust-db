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
import { field, text } from '@nozbe/watermelondb/decorators';
import type { Contender, Row } from '../contender';

class Message extends Model {
  static table = 'messages';

  @text('sender') sender!: string;
  @text('body') body!: string;
  @text('sent_at') sentAt!: string;
  @field('read') read!: boolean;
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
    const adapter = new SQLiteAdapter({
      schema,
      dbName: 'shootout_wmdb',
      jsi: true,
      onSetUpError: (e) => {
        throw e;
      },
    });
    db = new Database({ adapter, modelClasses: [Message] });
    await db.write(async () => {
      await db!.unsafeResetDatabase();
    });
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
      await messages().create((m) => {
        m._raw.id = row.id;
        m.sender = row.sender;
        m.body = row.body;
        m.sentAt = row.sent_at;
        m.read = row.read;
      });
    });
  },

  async insertMany(rows: Row[]) {
    // batch() is WatermelonDB's documented bulk path — one native call for the
    // whole set, which is the fair equivalent of a chunked multi-row INSERT.
    await db!.write(async () => {
      await db!.batch(
        rows.map((row) =>
          messages().prepareCreate((m) => {
            m._raw.id = row.id;
            m.sender = row.sender;
            m.body = row.body;
            m.sentAt = row.sent_at;
            m.read = row.read;
          }),
        ),
      );
    });
  },

  async readAll() {
    const all = await messages().query().fetch();
    // Touch a field so the comparison includes materializing usable values,
    // matching what the other contenders are made to do.
    let seen = 0;
    for (const m of all) if (m.sender) seen++;
    return seen;
  },

  async readPage(limit: number, offset: number) {
    const { Q } = await import('@nozbe/watermelondb');
    const page = await messages()
      .query(Q.skip(offset), Q.take(limit))
      .fetch();
    let seen = 0;
    for (const m of page) if (m.sender) seen++;
    return seen;
  },

  async updateSome(rows: Row[]) {
    await db!.write(async () => {
      const found = await messages()
        .query()
        .fetch();
      const byId = new Map(found.map((m) => [m.id, m]));
      const updates = rows
        .map((r) => byId.get(r.id))
        .filter((m): m is Message => !!m)
        .map((m) => m.prepareUpdate((rec) => { rec.read = !rec.read; }));
      await db!.batch(updates);
    });
  },
};
