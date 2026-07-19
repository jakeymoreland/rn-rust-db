import { decodeEntriesBuffer } from '../decode';

function encode(rows: Array<{ key: string; fields: Record<string, string> }>): ArrayBuffer {
  const te = new TextEncoder();
  const parts = rows.map((r) => ({ k: te.encode(r.key), j: te.encode(JSON.stringify(r.fields)) }));
  const len = 4 + parts.reduce((s, p) => s + 8 + p.k.length + p.j.length, 0);
  const buf = new ArrayBuffer(len);
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  let off = 0;
  dv.setUint32(off, rows.length, true);
  off += 4;
  for (const p of parts) {
    dv.setUint32(off, p.k.length, true);
    off += 4;
    u8.set(p.k, off);
    off += p.k.length;
    dv.setUint32(off, p.j.length, true);
    off += 4;
    u8.set(p.j, off);
    off += p.j.length;
  }
  return buf;
}

it('round-trips rows', () => {
  const rows: Array<{ key: string; fields: Record<string, string> }> = [
    { key: 'entry:c:1', fields: { name: 'Ann', city: 'Sydney' } },
    { key: 'entry:c:2', fields: { name: 'Bób', notes: 'ünïcödé' } },
  ];
  expect(decodeEntriesBuffer(encode(rows))).toEqual(rows);
});

it('decodes an empty collection', () => {
  expect(decodeEntriesBuffer(encode([]))).toEqual([]);
});

it('throws on truncated buffer', () => {
  const buf = encode([{ key: 'k', fields: {} }]).slice(0, 6);
  expect(() => decodeEntriesBuffer(buf)).toThrow();
});

const MISSING = 0xffffffff;

function encodeSchema(fields: string[], rows: Array<{ key: string; values: Array<string | null> }>): ArrayBuffer {
    const te = new TextEncoder();
    const chunks: Array<Uint8Array | number> = []; // number = u32
    chunks.push(fields.length);
    for (const f of fields) {
      const b = te.encode(f);
      chunks.push(b.length, b);
    }
    chunks.push(rows.length);
    for (const r of rows) {
      const k = te.encode(r.key);
      chunks.push(k.length, k);
      for (const v of r.values) {
        if (v === null) chunks.push(MISSING);
        else {
          const b = te.encode(v);
          chunks.push(b.length, b);
        }
      }
    }
    const len = chunks.reduce<number>((s, c) => s + (typeof c === 'number' ? 4 : c.length), 0);
    const buf = new ArrayBuffer(len);
    const dv = new DataView(buf);
    const u8 = new Uint8Array(buf);
    let off = 0;
    for (const c of chunks) {
      if (typeof c === 'number') {
        dv.setUint32(off, c, true);
        off += 4;
      } else {
        u8.set(c, off);
        off += c.length;
      }
    }
    return buf;
}

describe('decodeSchemaBuffer', () => {
  it('round-trips schema rows into keyed objects', () => {
    const { decodeSchemaBuffer } = require('../decode');
    const buf = encodeSchema(
      ['name', 'city'],
      [
        { key: 'entry:c:1', values: ['Ann', 'Sydney'] },
        { key: 'entry:c:2', values: ['Bób', null] },
      ],
    );
    expect(decodeSchemaBuffer(buf)).toEqual([
      { key: 'entry:c:1', fields: { name: 'Ann', city: 'Sydney' } },
      { key: 'entry:c:2', fields: { name: 'Bób' } },
    ]);
  });

  it('throws on truncated schema buffer', () => {
    const { decodeSchemaBuffer } = require('../decode');
    const buf = encodeSchema(['a'], [{ key: 'k', values: ['v'] }]).slice(0, 10);
    expect(() => decodeSchemaBuffer(buf)).toThrow();
  });
});

describe('createLazyRows', () => {
  const rows: Array<{ key: string; values: Array<string | null> }> = [
    { key: 'entry:c:1', values: ['Ann', 'Sydney'] },
    { key: 'entry:c:2', values: ['Bób', null] },
    { key: 'entry:c:3', values: ['Cat', 'Perth'] },
  ];

  it('materializes rows on demand, matching the eager decoder', () => {
    const { createLazyRows, decodeSchemaBuffer } = require('../decode');
    const buf = encodeSchema(['name', 'city'], rows);
    const lazy = createLazyRows(buf);
    const eager = decodeSchemaBuffer(buf);
    expect(lazy.length).toBe(3);
    expect(lazy.row(1)).toEqual(eager[1]);
    expect(lazy.row(0)).toEqual(eager[0]);
    expect(lazy.row(2)).toEqual(eager[2]);
  });

  it('memoizes materialized rows', () => {
    const { createLazyRows } = require('../decode');
    const lazy = createLazyRows(encodeSchema(['name', 'city'], rows));
    expect(lazy.row(1)).toBe(lazy.row(1)); // same object identity
  });

  it('throws on out-of-range index', () => {
    const { createLazyRows } = require('../decode');
    const lazy = createLazyRows(encodeSchema(['name', 'city'], rows));
    expect(() => lazy.row(3)).toThrow();
  });

  // Incremental indexing (perf): the constructor must not walk the whole
  // buffer, so a later corrupt row can't block earlier ones, and a high index
  // is reachable without touching earlier rows.
  it('indexes incrementally: early rows read despite later truncation', () => {
    const { createLazyRows } = require('../decode');
    const full = encodeSchema(['name', 'city'], rows);
    const truncated = full.slice(0, full.byteLength - 3);
    const lazy = createLazyRows(truncated);
    expect(lazy.length).toBe(3);
    expect(lazy.row(0)).toEqual({ key: 'entry:c:1', fields: { name: 'Ann', city: 'Sydney' } });
    expect(() => lazy.row(2)).toThrow();
  });

  it('materializes a high index without earlier access', () => {
    const { createLazyRows } = require('../decode');
    const many = Array.from({ length: 40 }, (_, i) => ({ key: `k${i}`, values: [String(i), null] as Array<string | null> }));
    const lazy = createLazyRows(encodeSchema(['n', 'c'], many));
    expect(lazy.row(37)).toEqual({ key: 'k37', fields: { n: '37' } });
  });
});

describe('utf8 fast-path decode (unicode correctness)', () => {
  it('lazy entry rows decode multibyte values correctly', () => {
    const { createLazyEntryRows } = require('../decode');
    const te = new TextEncoder();
    const fields = { name: 'Bób', emoji: '🌟', notes: 'plain ascii' };
    const k = te.encode('entry:c:1');
    const j = te.encode(JSON.stringify(fields));
    const buf = new ArrayBuffer(4 + 8 + k.length + j.length);
    const dv = new DataView(buf);
    const u8 = new Uint8Array(buf);
    let off = 0;
    dv.setUint32(off, 1, true); off += 4;
    dv.setUint32(off, k.length, true); off += 4; u8.set(k, off); off += k.length;
    dv.setUint32(off, j.length, true); off += 4; u8.set(j, off);
    expect(createLazyEntryRows(buf).row(0)).toEqual({ key: 'entry:c:1', fields });
  });

  it('lazy schema rows decode multibyte values correctly', () => {
    const { createLazyRows } = require('../decode');
    const buf = encodeSchema(['name', 'flag'], [{ key: 'ké', values: ['Zöe', '🚀'] }]);
    expect(createLazyRows(buf).row(0)).toEqual({ key: 'ké', fields: { name: 'Zöe', flag: '🚀' } });
  });
});

describe('createLazyEntryRows', () => {
  function encodeEntries(rows: Array<{ key: string; fields: Record<string, string> }>): ArrayBuffer {
    const te = new TextEncoder();
    const parts = rows.map((r) => ({ k: te.encode(r.key), j: te.encode(JSON.stringify(r.fields)) }));
    const len = 4 + parts.reduce((s, p) => s + 8 + p.k.length + p.j.length, 0);
    const buf = new ArrayBuffer(len);
    const dv = new DataView(buf);
    const u8 = new Uint8Array(buf);
    let off = 0;
    dv.setUint32(off, rows.length, true);
    off += 4;
    for (const p of parts) {
      dv.setUint32(off, p.k.length, true);
      off += 4;
      u8.set(p.k, off);
      off += p.k.length;
      dv.setUint32(off, p.j.length, true);
      off += 4;
      u8.set(p.j, off);
      off += p.j.length;
    }
    return buf;
  }

  const rows: Array<{ key: string; fields: Record<string, string> }> = [
    { key: 'entry:c:1', fields: { name: 'Ann', city: 'Sydney' } },
    { key: 'entry:c:2', fields: { name: 'Bób', notes: 'ünïcödé' } },
  ];

  it('materializes plain-format rows on demand, matching the eager decoder', () => {
    const { createLazyEntryRows, decodeEntriesBuffer } = require('../decode');
    const buf = encodeEntries(rows);
    const lazy = createLazyEntryRows(buf);
    expect(lazy.length).toBe(2);
    expect(lazy.row(1)).toEqual(decodeEntriesBuffer(buf)[1]);
    expect(lazy.row(0)).toEqual(decodeEntriesBuffer(buf)[0]);
    expect(lazy.row(0)).toBe(lazy.row(0)); // memoized
  });

  it('throws on out-of-range index', () => {
    const { createLazyEntryRows } = require('../decode');
    const lazy = createLazyEntryRows(encodeEntries(rows));
    expect(() => lazy.row(2)).toThrow();
  });

  // Lazy indexing (perf): the constructor no longer walks the whole buffer, so
  // corruption in a LATER row must not stop earlier rows from materializing —
  // and length is still available from the header without a full walk.
  it('indexes incrementally: early rows read despite later truncation', () => {
    const { createLazyEntryRows } = require('../decode');
    const three = [
      { key: 'entry:c:1', fields: { name: 'Ann' } },
      { key: 'entry:c:2', fields: { name: 'Bob' } },
      { key: 'entry:c:3', fields: { name: 'Cat' } },
    ];
    const full = encodeEntries(three);
    // Cut the buffer partway into the third row; header still says 3 rows.
    const truncated = full.slice(0, full.byteLength - 4);
    const lazy = createLazyEntryRows(truncated);
    expect(lazy.length).toBe(3); // length from header, no walk needed
    expect(lazy.row(0)).toEqual({ key: 'entry:c:1', fields: { name: 'Ann' } });
    expect(lazy.row(1)).toEqual({ key: 'entry:c:2', fields: { name: 'Bob' } });
    expect(() => lazy.row(2)).toThrow(); // corruption surfaces only on access
  });

  it('materializes a high index without requiring earlier access', () => {
    const { createLazyEntryRows } = require('../decode');
    const many = Array.from({ length: 50 }, (_, i) => ({
      key: `entry:c:${i}`,
      fields: { n: String(i) },
    }));
    const lazy = createLazyEntryRows(encodeEntries(many));
    expect(lazy.row(42)).toEqual({ key: 'entry:c:42', fields: { n: '42' } });
  });

  it('throws on a header that undershoots the buffer minimum', () => {
    const { createLazyEntryRows } = require('../decode');
    expect(() => createLazyEntryRows(new ArrayBuffer(2))).toThrow();
  });
});
