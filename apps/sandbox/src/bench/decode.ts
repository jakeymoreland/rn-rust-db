export type Row = { key: string; fields: Record<string, string> };

// Wire format (see cpp/NativeReconcileEngine.cpp queryEntriesBuffer):
// LE [u32 count]([u32 klen][key utf8][u32 jlen][fields-json utf8])*
export function decodeEntriesBuffer(buf: ArrayBuffer): Row[] {
  const dv = new DataView(buf);
  const td = new TextDecoder();
  let off = 0;
  const u32 = (): number => {
    if (off + 4 > buf.byteLength) throw new Error('corrupt entry buffer');
    const v = dv.getUint32(off, true);
    off += 4;
    return v;
  };
  const str = (n: number): string => {
    if (off + n > buf.byteLength) throw new Error('corrupt entry buffer');
    const s = td.decode(new Uint8Array(buf, off, n));
    off += n;
    return s;
  };
  const count = u32();
  const out: Row[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const key = str(u32());
    out[i] = { key, fields: JSON.parse(str(u32())) };
  }
  return out;
}

const SCHEMA_FIELD_MISSING = 0xffffffff;

export type LazyRows = {
  length: number;
  /** Materializes (and memoizes) row i from the underlying buffer. */
  row(i: number): Row;
};

// The on-demand half of the flat-buffer pattern: walk the buffer once
// recording row byte-offsets (u32 skips only — no string decoding, no object
// allocation), then materialize individual rows as they are accessed. A
// virtualized list touching 20 of 10k rows only ever decodes those 20.
export function createLazyRows(buf: ArrayBuffer): LazyRows {
  const dv = new DataView(buf);
  const td = new TextDecoder();
  let off = 0;
  const u32 = (): number => {
    if (off + 4 > buf.byteLength) throw new Error('corrupt schema buffer');
    const v = dv.getUint32(off, true);
    off += 4;
    return v;
  };
  const nFields = u32();
  const fields: string[] = new Array(nFields);
  for (let i = 0; i < nFields; i++) {
    const len = u32();
    fields[i] = td.decode(new Uint8Array(buf, off, len));
    off += len;
  }
  const count = u32();
  const offsets = new Uint32Array(count);
  for (let i = 0; i < count; i++) {
    offsets[i] = off;
    const klen = u32();
    off += klen;
    for (let f = 0; f < nFields; f++) {
      const vlen = u32();
      if (vlen !== SCHEMA_FIELD_MISSING) off += vlen;
    }
  }
  const memo: Array<Row | undefined> = new Array(count);
  return {
    length: count,
    row(i: number): Row {
      if (i < 0 || i >= count) throw new Error(`row ${i} out of range (0..${count - 1})`);
      const cached = memo[i];
      if (cached) return cached;
      let p = offsets[i];
      const read = (): number => {
        const v = dv.getUint32(p, true);
        p += 4;
        return v;
      };
      const klen = read();
      const key = td.decode(new Uint8Array(buf, p, klen));
      p += klen;
      const rec: Record<string, string> = {};
      for (let f = 0; f < nFields; f++) {
        const vlen = read();
        if (vlen === SCHEMA_FIELD_MISSING) continue;
        rec[fields[f]] = td.decode(new Uint8Array(buf, p, vlen));
        p += vlen;
      }
      const rowObj = { key, fields: rec };
      memo[i] = rowObj;
      return rowObj;
    },
  };
}

// Schema-packed wire format (see engine_query_entries_schema_bin in engine.h):
// LE [u32 nFields]([u32 len][name])* [u32 count] then per row
// [u32 klen][key] and one [u32 vlen][value] per field in table order
// (vlen = 0xFFFFFFFF marks a missing/null field). No JSON.parse needed.
export function decodeSchemaBuffer(buf: ArrayBuffer): Row[] {
  const dv = new DataView(buf);
  const td = new TextDecoder();
  let off = 0;
  const u32 = (): number => {
    if (off + 4 > buf.byteLength) throw new Error('corrupt schema buffer');
    const v = dv.getUint32(off, true);
    off += 4;
    return v;
  };
  const str = (n: number): string => {
    if (off + n > buf.byteLength) throw new Error('corrupt schema buffer');
    const s = td.decode(new Uint8Array(buf, off, n));
    off += n;
    return s;
  };
  const nFields = u32();
  const fields: string[] = new Array(nFields);
  for (let i = 0; i < nFields; i++) fields[i] = str(u32());
  const count = u32();
  const out: Row[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const key = str(u32());
    const rec: Record<string, string> = {};
    for (let f = 0; f < nFields; f++) {
      const vlen = u32();
      if (vlen === SCHEMA_FIELD_MISSING) continue;
      rec[fields[f]] = str(vlen);
    }
    out[i] = { key, fields: rec };
  }
  return out;
}
