pub fn encode_entries(rows: &[(String, String)]) -> Vec<u8> {
    let mut buf = Vec::with_capacity(4 + rows.iter().map(|(k, v)| 8 + k.len() + v.len()).sum::<usize>());
    buf.extend_from_slice(&(rows.len() as u32).to_le_bytes());
    for (key, json) in rows {
        buf.extend_from_slice(&(key.len() as u32).to_le_bytes());
        buf.extend_from_slice(key.as_bytes());
        buf.extend_from_slice(&(json.len() as u32).to_le_bytes());
        buf.extend_from_slice(json.as_bytes());
    }
    buf
}

/// Sentinel length marking a field that is absent (or JSON null) in a row.
pub const SCHEMA_FIELD_MISSING: u32 = u32::MAX;

/// Schema-packed rows: the field table is written once, then each row carries
/// only length-prefixed values in table order — no JSON for JS to parse.
/// LE layout:
///   [u32 nFields]([u32 len][name])*
///   [u32 rowCount]
///   per row: [u32 klen][key] then per field [u32 vlen][value] (vlen = u32::MAX -> missing)
/// Non-string JSON values are serialized with to_string() (e.g. 12.5 -> "12.5").
pub fn encode_entries_schema(rows: &[(String, String)], fields: &[&str]) -> Vec<u8> {
    let mut buf = Vec::new();
    buf.extend_from_slice(&(fields.len() as u32).to_le_bytes());
    for f in fields {
        buf.extend_from_slice(&(f.len() as u32).to_le_bytes());
        buf.extend_from_slice(f.as_bytes());
    }
    buf.extend_from_slice(&(rows.len() as u32).to_le_bytes());
    for (key, json) in rows {
        buf.extend_from_slice(&(key.len() as u32).to_le_bytes());
        buf.extend_from_slice(key.as_bytes());
        let parsed: serde_json::Value = serde_json::from_str(json).unwrap_or(serde_json::Value::Null);
        for f in fields {
            match parsed.get(*f) {
                None | Some(serde_json::Value::Null) => {
                    buf.extend_from_slice(&SCHEMA_FIELD_MISSING.to_le_bytes());
                }
                Some(serde_json::Value::String(s)) => {
                    buf.extend_from_slice(&(s.len() as u32).to_le_bytes());
                    buf.extend_from_slice(s.as_bytes());
                }
                Some(v) => {
                    let s = v.to_string();
                    buf.extend_from_slice(&(s.len() as u32).to_le_bytes());
                    buf.extend_from_slice(s.as_bytes());
                }
            }
        }
    }
    buf
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_rows_le() {
        let rows = vec![("k1".to_string(), "{\"a\":1}".to_string())];
        let buf = encode_entries(&rows);
        assert_eq!(&buf[0..4], &1u32.to_le_bytes());
        assert_eq!(&buf[4..8], &2u32.to_le_bytes());
        assert_eq!(&buf[8..10], b"k1");
        assert_eq!(&buf[10..14], &7u32.to_le_bytes());
        assert_eq!(&buf[14..21], b"{\"a\":1}");
    }

    #[test]
    fn empty_is_just_count() {
        assert_eq!(encode_entries(&[]), 0u32.to_le_bytes().to_vec());
    }

    #[test]
    fn schema_encodes_field_table_and_values() {
        let rows = vec![("k1".to_string(), r#"{"name":"Ann","age":30}"#.to_string())];
        let buf = encode_entries_schema(&rows, &["name", "age", "missing"]);
        let mut off = 0usize;
        let u32_at = |b: &[u8], o: usize| u32::from_le_bytes(b[o..o + 4].try_into().unwrap());
        assert_eq!(u32_at(&buf, off), 3); // nFields
        off += 4;
        for expected in ["name", "age", "missing"] {
            let len = u32_at(&buf, off) as usize;
            off += 4;
            assert_eq!(&buf[off..off + len], expected.as_bytes());
            off += len;
        }
        assert_eq!(u32_at(&buf, off), 1); // rowCount
        off += 4;
        let klen = u32_at(&buf, off) as usize;
        off += 4;
        assert_eq!(&buf[off..off + klen], b"k1");
        off += klen;
        // name = "Ann"
        assert_eq!(u32_at(&buf, off), 3);
        off += 4;
        assert_eq!(&buf[off..off + 3], b"Ann");
        off += 3;
        // age is numeric -> "30"
        assert_eq!(u32_at(&buf, off), 2);
        off += 4;
        assert_eq!(&buf[off..off + 2], b"30");
        off += 2;
        // missing -> sentinel
        assert_eq!(u32_at(&buf, off), SCHEMA_FIELD_MISSING);
        off += 4;
        assert_eq!(off, buf.len());
    }

    #[test]
    fn schema_handles_unparseable_fields_json() {
        let rows = vec![("k".to_string(), "not json".to_string())];
        let buf = encode_entries_schema(&rows, &["a"]);
        // 1 field table entry + 1 row with key "k" and one missing value
        let tail = &buf[buf.len() - 4..];
        assert_eq!(u32::from_le_bytes(tail.try_into().unwrap()), SCHEMA_FIELD_MISSING);
    }
}
