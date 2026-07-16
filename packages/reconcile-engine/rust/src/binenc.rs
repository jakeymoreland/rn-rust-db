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
}
