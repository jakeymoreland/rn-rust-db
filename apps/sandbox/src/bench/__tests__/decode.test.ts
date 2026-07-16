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

describe('decodeSchemaBuffer', () => {
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
