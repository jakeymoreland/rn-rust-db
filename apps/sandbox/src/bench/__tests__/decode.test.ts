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
