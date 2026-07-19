export type Row = { key: string; fields: Record<string, string> };

// Decodes `len` UTF-8 bytes at `off`. Fast path: field values and keys are
// overwhelmingly short ASCII, and per-field TextDecoder.decode is the proven
// hot spot when materializing rows (millions of tiny decodes in Hermes). When
// the bytes are pure ASCII we build the string with String.fromCharCode (no
// TextDecoder setup per call); any high byte falls back to a shared decoder,
// so multibyte values stay correct.
function decodeUtf8(buf: ArrayBuffer, off: number, len: number, td: TextDecoder): string {
  const bytes = new Uint8Array(buf, off, len);
  for (let i = 0; i < len; i++) {
    if (bytes[i] >= 0x80) return td.decode(bytes);
  }
  // pure ASCII: chunk to stay under the fromCharCode argument limit
  if (len <= 8192) {
    return String.fromCharCode.apply(null, bytes as unknown as number[]);
  }
  let s = '';
  for (let p = 0; p < len; p += 8192) {
    s += String.fromCharCode.apply(null, bytes.subarray(p, Math.min(p + 8192, len)) as unknown as number[]);
  }
  return s;
}

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
    const s = decodeUtf8(buf, off, n, td);
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

// Lazy view over the PLAIN entries wire format (count, then klen/key/jlen/json
// per row). Row start-offsets are indexed INCREMENTALLY — the constructor only
// reads the count, and accessing row i walks the buffer forward just far enough
// to reach it (caching progress). A virtualized list touching 20 of 10k rows
// therefore pays O(20) index reads, not O(10k): the constructor no longer walks
// the whole buffer. Materialization is a single-row JSON.parse; the native side
// ships stored JSON verbatim with no per-row re-encoding.
export function createLazyEntryRows(buf: ArrayBuffer): LazyRows {
  const dv = new DataView(buf);
  const td = new TextDecoder();
  if (buf.byteLength < 4) throw new Error('corrupt entry buffer');
  const count = dv.getUint32(0, true);
  const offsets = new Uint32Array(count);
  const memo: Array<Row | undefined> = new Array(count);
  // Rows [0, indexed) have their start byte-offset recorded in `offsets`.
  // `nextOffset` is where the first un-indexed row begins.
  let indexed = 0;
  let nextOffset = 4;

  // Records start offsets up to and including row `target`, validating bounds
  // as it skips each row (2 u32 length prefixes, no string decoding).
  const ensureIndexed = (target: number): void => {
    while (indexed <= target) {
      let p = nextOffset;
      offsets[indexed] = p;
      if (p + 4 > buf.byteLength) throw new Error('corrupt entry buffer');
      p += 4 + dv.getUint32(p, true); // skip key
      if (p + 4 > buf.byteLength) throw new Error('corrupt entry buffer');
      p += 4 + dv.getUint32(p, true); // skip fields json
      if (p > buf.byteLength) throw new Error('corrupt entry buffer');
      nextOffset = p;
      indexed++;
    }
  };

  return {
    length: count,
    row(i: number): Row {
      if (i < 0 || i >= count) throw new Error(`row ${i} out of range (0..${count - 1})`);
      const cached = memo[i];
      if (cached) return cached;
      ensureIndexed(i);
      let p = offsets[i];
      const klen = dv.getUint32(p, true);
      p += 4;
      const key = decodeUtf8(buf, p, klen, td);
      p += klen;
      const jlen = dv.getUint32(p, true);
      p += 4;
      const rowObj = { key, fields: JSON.parse(decodeUtf8(buf, p, jlen, td)) };
      memo[i] = rowObj;
      return rowObj;
    },
  };
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
  const headU32 = (): number => {
    if (off + 4 > buf.byteLength) throw new Error('corrupt schema buffer');
    const v = dv.getUint32(off, true);
    off += 4;
    return v;
  };
  // The field table is small and read once; decoding it up front is fine.
  const nFields = headU32();
  const fields: string[] = new Array(nFields);
  for (let i = 0; i < nFields; i++) {
    const len = headU32();
    if (off + len > buf.byteLength) throw new Error('corrupt schema buffer');
    fields[i] = decodeUtf8(buf, off, len, td);
    off += len;
  }
  const count = headU32();
  // Row offsets are indexed INCREMENTALLY (as for createLazyEntryRows): the
  // constructor stops after the field table, and accessing row i walks the
  // rows just far enough to reach it. Materializing a 50-row window over a
  // 100k-row buffer costs O(50), not O(100k).
  const offsets = new Uint32Array(count);
  const memo: Array<Row | undefined> = new Array(count);
  let indexed = 0;
  let nextOffset = off;

  const ensureIndexed = (target: number): void => {
    while (indexed <= target) {
      let p = nextOffset;
      offsets[indexed] = p;
      if (p + 4 > buf.byteLength) throw new Error('corrupt schema buffer');
      p += 4 + dv.getUint32(p, true); // skip key
      for (let f = 0; f < nFields; f++) {
        if (p + 4 > buf.byteLength) throw new Error('corrupt schema buffer');
        const vlen = dv.getUint32(p, true);
        p += 4;
        if (vlen !== SCHEMA_FIELD_MISSING) p += vlen;
      }
      if (p > buf.byteLength) throw new Error('corrupt schema buffer');
      nextOffset = p;
      indexed++;
    }
  };

  return {
    length: count,
    row(i: number): Row {
      if (i < 0 || i >= count) throw new Error(`row ${i} out of range (0..${count - 1})`);
      const cached = memo[i];
      if (cached) return cached;
      ensureIndexed(i);
      let p = offsets[i];
      const klen = dv.getUint32(p, true);
      p += 4;
      const key = decodeUtf8(buf, p, klen, td);
      p += klen;
      const rec: Record<string, string> = {};
      for (let f = 0; f < nFields; f++) {
        const vlen = dv.getUint32(p, true);
        p += 4;
        if (vlen === SCHEMA_FIELD_MISSING) continue;
        rec[fields[f]] = decodeUtf8(buf, p, vlen, td);
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
    const s = decodeUtf8(buf, off, n, td);
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
