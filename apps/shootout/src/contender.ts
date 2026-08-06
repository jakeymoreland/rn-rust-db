// A head-to-head between React Native on-device databases.
//
// The point of this app is fairness, not flattery. Our own engine is one
// contender among several and gets no special treatment: same rows, same batch
// sizes, same durability setting, same timing harness, same device, same run.
//
// Every unfair comparison this repo has published so far came from an
// uncontrolled variable — a parser measured against a database write, a browser
// suite quoted against native SQLite, a benchmark timing its own `await`. The
// interface below exists to make those mistakes hard: a contender declares what
// it actually guarantees, and the report prints that next to its number.

/** What a write has survived by the time the call resolves. */
export type Durability =
  /** Nothing. In-memory only, or fire-and-forget. */
  | 'none'
  /** The write is in the OS page cache / WAL. Survives an app crash, not power loss. */
  | 'app-crash'
  /** A real barrier (F_FULLFSYNC on Apple). Survives power loss. */
  | 'power-loss';

export type Row = {
  id: string;
  sender: string;
  body: string;
  sent_at: string;
  read: boolean;
};

/**
 * One database under test.
 *
 * Implementations must do the *equivalent* work, not the same code — that is
 * the whole point. Where a contender cannot do something (no field-level merge,
 * no windowed query), it returns `null` from that operation rather than
 * substituting a cheaper one, and the report shows a gap instead of a number.
 */
export type Contender = {
  name: string;
  /** e.g. "SQLite WAL, synchronous=NORMAL" — printed next to every result. */
  configuration: string;
  durability: Durability;
  /** Anything a reader needs to judge the comparison. Printed with the results. */
  caveats?: string[];

  /** Fresh, empty store. Called before every scenario. */
  setup(): Promise<void>;
  /** Release handles and delete files, so the next contender starts clean. */
  teardown(): Promise<void>;

  /** Insert one row. The single-insert latency everyone quotes. */
  insertOne(row: Row): Promise<void>;
  /** Insert many rows in whatever batching the library considers idiomatic. */
  insertMany(rows: Row[]): Promise<void>;
  /** Read every row back as usable JS objects. */
  readAll(): Promise<number>;
  /** Read one page. `null` if the library has no windowed read. */
  readPage?(limit: number, offset: number): Promise<number>;
  /** Update one field on `count` existing rows. */
  updateSome(rows: Row[]): Promise<void>;
};

export function makeRows(count: number, prefix: string): Row[] {
  const rows: Row[] = new Array(count);
  for (let i = 0; i < count; i++) {
    rows[i] = {
      id: `${prefix}-${i}`,
      sender: `user${i % 50}`,
      body: 'hello there, this is a chat message body '.repeat(3),
      sent_at: new Date(1785000000000 + i * 1000).toISOString(),
      read: i % 3 === 0,
    };
  }
  return rows;
}
