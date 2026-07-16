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
