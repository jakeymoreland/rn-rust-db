use crate::error::EngineError;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub enum SourceFormat {
    Json,
    Csv,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SourceConfig {
    pub source_id: String,
    pub format: SourceFormat,
    pub collection: String,
    pub natural_key_field: String,
    pub timestamp_field: Option<String>,
    pub priority: u32,
}

#[derive(Clone, Debug, PartialEq)]
pub struct CanonicalRecord {
    pub collection: String,
    pub natural_key: String,
    pub source: String,
    pub fields: BTreeMap<String, String>,
    pub updated_at: i64,
}

#[derive(Debug)]
pub struct NormalizeOutcome {
    pub records: Vec<CanonicalRecord>,
    pub rejects: Vec<(String, String)>,
}

pub fn normalize(
    cfg: &SourceConfig,
    payload: &str,
    now_ms: i64,
) -> Result<NormalizeOutcome, EngineError> {
    match cfg.format {
        SourceFormat::Json => normalize_json(cfg, payload, now_ms),
        SourceFormat::Csv => normalize_csv(cfg, payload, now_ms),
    }
}

fn value_to_string(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::String(s) => s.clone(),
        // Canonicalize numbers so numerically-equal values from different
        // sources/formats converge to one stored form (audit S1): integral
        // floats lose the ".0", ints/u64s print plainly.
        serde_json::Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                i.to_string()
            } else if let Some(u) = n.as_u64() {
                u.to_string()
            } else if let Some(f) = n.as_f64() {
                if f.is_finite() && f.fract() == 0.0 && f.abs() < 9.007_199_254_740_992e15 {
                    format!("{}", f as i64)
                } else {
                    n.to_string()
                }
            } else {
                n.to_string()
            }
        }
        other => other.to_string(),
    }
}

/// Parses a timestamp field value: integer ms, float ms (truncated), or an
/// RFC-3339 subset `YYYY-MM-DDTHH:MM:SS[.frac](Z|±HH:MM)`. None = unparseable.
pub(crate) fn parse_timestamp_ms(s: &str) -> Option<i64> {
    let s = s.trim();
    if s.is_empty() {
        return None;
    }
    if let Ok(v) = s.parse::<i64>() {
        return Some(v);
    }
    if let Ok(f) = s.parse::<f64>() {
        if f.is_finite() && f.abs() < 9.007_199_254_740_992e15 {
            return Some(f.trunc() as i64);
        }
        return None;
    }
    parse_rfc3339_ms(s)
}

fn parse_rfc3339_ms(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() < 20 {
        return None;
    }
    let num = |r: std::ops::Range<usize>| -> Option<i64> {
        let sub = b.get(r)?;
        if sub.is_empty() || !sub.iter().all(u8::is_ascii_digit) {
            return None;
        }
        std::str::from_utf8(sub).ok()?.parse().ok()
    };
    if b[4] != b'-' || b[7] != b'-' || !(b[10] == b'T' || b[10] == b't') || b[13] != b':' || b[16] != b':' {
        return None;
    }
    let (y, mo, d) = (num(0..4)?, num(5..7)?, num(8..10)?);
    let (h, mi, sec) = (num(11..13)?, num(14..16)?, num(17..19)?);
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || sec > 60 {
        return None;
    }
    let mut i = 19;
    let mut frac_ms = 0i64;
    if b.get(i) == Some(&b'.') {
        let start = i + 1;
        let mut end = start;
        while end < b.len() && b[end].is_ascii_digit() {
            end += 1;
        }
        if end == start {
            return None;
        }
        let ms_digits: String = s[start..end].chars().chain("000".chars()).take(3).collect();
        frac_ms = ms_digits.parse().ok()?;
        i = end;
    }
    let offset_min: i64 = match b.get(i) {
        Some(b'Z') | Some(b'z') if i + 1 == b.len() => 0,
        Some(&c @ (b'+' | b'-')) => {
            if b.len() != i + 6 || b[i + 3] != b':' {
                return None;
            }
            let oh = num(i + 1..i + 3)?;
            let om = num(i + 4..i + 6)?;
            if oh > 23 || om > 59 {
                return None;
            }
            let v = oh * 60 + om;
            if c == b'-' {
                -v
            } else {
                v
            }
        }
        _ => return None,
    };
    let days = days_from_civil(y, mo, d);
    // Leap seconds clamp to :59 rather than rejecting.
    Some(((days * 86_400 + h * 3600 + mi * 60 + sec.min(59)) * 1000 + frac_ms) - offset_min * 60_000)
}

/// Howard Hinnant's days-from-civil algorithm (proleptic Gregorian).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn build_record(
    cfg: &SourceConfig,
    fields: BTreeMap<String, String>,
    fragment: &str,
    now_ms: i64,
) -> Result<CanonicalRecord, (String, String)> {
    let natural_key = match fields.get(&cfg.natural_key_field) {
        Some(k) if !k.is_empty() => k.clone(),
        _ => {
            return Err((
                fragment.to_string(),
                format!("missing natural key field '{}'", cfg.natural_key_field),
            ))
        }
    };
    // Audit C1: a configured timestamp field that is present but unparseable
    // dead-letters the record — silently substituting ingest time corrupts
    // last-writer-wins ordering. now_ms only applies when no timestamp field
    // is configured or the record simply lacks it.
    let updated_at = match cfg.timestamp_field.as_ref().and_then(|tf| fields.get(tf)) {
        Some(v) => match parse_timestamp_ms(v) {
            Some(ms) => ms,
            None => {
                return Err((
                    fragment.to_string(),
                    format!("unparseable timestamp '{v}' in field '{}'", cfg.timestamp_field.as_deref().unwrap_or("")),
                ))
            }
        },
        None => now_ms,
    };
    Ok(CanonicalRecord {
        collection: cfg.collection.clone(),
        natural_key,
        source: cfg.source_id.clone(),
        fields,
        updated_at,
    })
}

fn normalize_json(
    cfg: &SourceConfig,
    payload: &str,
    now_ms: i64,
) -> Result<NormalizeOutcome, EngineError> {
    let parsed: serde_json::Value = serde_json::from_str(payload)
        .map_err(|e| EngineError::Parse(e.to_string()))?;
    let arr = parsed
        .as_array()
        .ok_or_else(|| EngineError::Parse("expected top-level JSON array".into()))?;
    let mut out = NormalizeOutcome { records: vec![], rejects: vec![] };
    for item in arr {
        let fragment = item.to_string();
        let obj = match item.as_object() {
            Some(o) => o,
            None => {
                out.rejects.push((fragment, "expected JSON object".into()));
                continue;
            }
        };
        // Audit C2: validate the natural key on the RAW JSON value before
        // stringification — null coerces to "null", floats to "1.0" etc.,
        // silently merging or splitting unrelated records. Allowed: non-empty
        // strings and integer numbers (which share the string form on purpose).
        let key_ok = matches!(
            obj.get(&cfg.natural_key_field),
            Some(serde_json::Value::String(s)) if !s.is_empty()
        ) || matches!(
            obj.get(&cfg.natural_key_field),
            Some(serde_json::Value::Number(n)) if n.as_i64().is_some() || n.as_u64().is_some()
        );
        if !key_ok {
            out.rejects.push((
                fragment,
                format!("invalid natural key field '{}'", cfg.natural_key_field),
            ));
            continue;
        }
        let fields: BTreeMap<String, String> = obj
            .iter()
            .map(|(k, v)| (k.clone(), value_to_string(v)))
            .collect();
        match build_record(cfg, fields, &fragment, now_ms) {
            Ok(r) => out.records.push(r),
            Err(rej) => out.rejects.push(rej),
        }
    }
    Ok(out)
}

/// Minimal RFC-4180 subset parser: quoted fields, "" escapes, \r\n or \n rows.
/// Returns each row's parsed fields plus the raw source line (byte-exact,
/// minus the row terminator) so rejects quarantine faithfully (audit S3).
fn parse_csv_rows(payload: &str) -> Vec<(Vec<String>, String)> {
    let mut rows: Vec<(Vec<String>, String)> = Vec::new();
    let mut row: Vec<String> = Vec::new();
    let mut field = String::new();
    let mut in_quotes = false;
    let mut row_start = 0usize;
    let mut chars = payload.char_indices().peekable();
    while let Some((idx, c)) = chars.next() {
        if in_quotes {
            match c {
                '"' => {
                    if chars.peek().map(|&(_, c)| c) == Some('"') {
                        chars.next();
                        field.push('"');
                    } else {
                        in_quotes = false;
                    }
                }
                _ => field.push(c),
            }
        } else {
            match c {
                '"' => in_quotes = true,
                ',' => {
                    row.push(std::mem::take(&mut field));
                }
                '\r' => {}
                '\n' => {
                    row.push(std::mem::take(&mut field));
                    let end = if idx > row_start && payload.as_bytes()[idx - 1] == b'\r' {
                        idx - 1
                    } else {
                        idx
                    };
                    let raw = payload[row_start..end].to_string();
                    rows.push((std::mem::take(&mut row), raw));
                    row_start = idx + 1;
                }
                _ => field.push(c),
            }
        }
    }
    if !field.is_empty() || !row.is_empty() {
        row.push(field);
        let raw = payload[row_start..].trim_end_matches('\r').to_string();
        rows.push((row, raw));
    }
    rows
}

fn normalize_csv(
    cfg: &SourceConfig,
    payload: &str,
    now_ms: i64,
) -> Result<NormalizeOutcome, EngineError> {
    let rows = parse_csv_rows(payload);
    if rows.is_empty() {
        return Err(EngineError::Parse("empty CSV payload".into()));
    }
    let header = &rows[0].0;
    // Audit F10: duplicate header names would silently let the last column
    // win; if that column is the key or timestamp field the wrong data drives
    // merging, so the whole batch fails loudly instead.
    let mut seen = std::collections::BTreeSet::new();
    for h in header {
        if !seen.insert(h) {
            return Err(EngineError::Parse(format!("duplicate CSV header '{h}'")));
        }
    }
    let mut out = NormalizeOutcome { records: vec![], rejects: vec![] };
    for (row, raw) in &rows[1..] {
        let fragment = raw.clone();
        if row.len() != header.len() {
            out.rejects.push((
                fragment,
                format!("expected {} columns, got {}", header.len(), row.len()),
            ));
            continue;
        }
        let fields: BTreeMap<String, String> = header
            .iter()
            .cloned()
            .zip(row.iter().cloned())
            .collect();
        match build_record(cfg, fields, &fragment, now_ms) {
            Ok(r) => out.records.push(r),
            Err(rej) => out.rejects.push(rej),
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn json_cfg() -> SourceConfig {
        SourceConfig {
            source_id: "api".into(),
            format: SourceFormat::Json,
            collection: "people".into(),
            natural_key_field: "email".into(),
            timestamp_field: Some("updatedAt".into()),
            priority: 10,
        }
    }

    fn csv_cfg() -> SourceConfig {
        SourceConfig {
            source_id: "csv".into(),
            format: SourceFormat::Csv,
            collection: "people".into(),
            natural_key_field: "email".into(),
            timestamp_field: None,
            priority: 5,
        }
    }

    #[test]
    fn json_happy_path() {
        let payload = r#"[
            {"email":"a@x.com","name":"Ann","age":30,"updatedAt":1000},
            {"email":"b@x.com","name":"Bob","active":true,"updatedAt":2000}
        ]"#;
        let out = normalize(&json_cfg(), payload, 99).unwrap();
        assert_eq!(out.records.len(), 2);
        assert!(out.rejects.is_empty());
        let r = &out.records[0];
        assert_eq!(r.collection, "people");
        assert_eq!(r.natural_key, "a@x.com");
        assert_eq!(r.source, "api");
        assert_eq!(r.fields["name"], "Ann");
        assert_eq!(r.fields["age"], "30");
        assert_eq!(r.updated_at, 1000);
        assert_eq!(out.records[1].fields["active"], "true");
    }

    #[test]
    fn json_missing_key_is_reject_not_failure() {
        let payload = r#"[{"name":"NoKey"},{"email":"ok@x.com","name":"Ok"}]"#;
        let out = normalize(&json_cfg(), payload, 42).unwrap();
        assert_eq!(out.records.len(), 1);
        assert_eq!(out.rejects.len(), 1);
        assert!(out.rejects[0].1.contains("email"));
        // no timestamp field on the good record -> falls back to now_ms
        assert_eq!(out.records[0].updated_at, 42);
    }

    #[test]
    fn json_non_array_is_parse_error() {
        assert!(matches!(
            normalize(&json_cfg(), r#"{"not":"array"}"#, 0),
            Err(crate::error::EngineError::Parse(_))
        ));
    }

    #[test]
    fn csv_happy_path_with_quotes() {
        let payload = "email,name,notes\na@x.com,Ann,\"likes, commas\"\nb@x.com,Bob,\"say \"\"hi\"\"\"\n";
        let out = normalize(&csv_cfg(), payload, 7).unwrap();
        assert_eq!(out.records.len(), 2);
        assert_eq!(out.records[0].fields["notes"], "likes, commas");
        assert_eq!(out.records[1].fields["notes"], "say \"hi\"");
        assert_eq!(out.records[0].updated_at, 7);
    }

    #[test]
    fn parse_timestamp_ms_accepts_int_float_rfc3339() {
        assert_eq!(parse_timestamp_ms("1721000000000"), Some(1721000000000));
        assert_eq!(parse_timestamp_ms("-5"), Some(-5));
        assert_eq!(parse_timestamp_ms("1721000000000.75"), Some(1721000000000));
        assert_eq!(parse_timestamp_ms("2026-07-17T00:00:00Z"), Some(1784246400000));
        assert_eq!(parse_timestamp_ms("2026-07-17T00:00:00.5+00:00"), Some(1784246400500));
        assert_eq!(parse_timestamp_ms("2026-07-17T10:00:00+10:00"), Some(1784246400000));
        assert_eq!(parse_timestamp_ms("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_timestamp_ms("1969-12-31T23:59:59Z"), Some(-1000));
        assert_eq!(parse_timestamp_ms("not-a-date"), None);
        assert_eq!(parse_timestamp_ms(""), None);
        assert_eq!(parse_timestamp_ms("2026-07-17"), None);
        assert_eq!(parse_timestamp_ms("2026-13-01T00:00:00Z"), None);
        assert_eq!(parse_timestamp_ms("2026-07-17T00:00:00"), None); // no offset
        assert_eq!(parse_timestamp_ms("NaN"), None);
        assert_eq!(parse_timestamp_ms("inf"), None);
    }

    #[test]
    fn unparseable_timestamp_rejects_record() {
        let payload = r#"[{"email":"a@x.com","name":"A","updatedAt":"yesterday"}]"#;
        let out = normalize(&json_cfg(), payload, 42).unwrap();
        assert!(out.records.is_empty());
        assert_eq!(out.rejects.len(), 1);
        assert!(out.rejects[0].1.contains("unparseable timestamp"));
    }

    #[test]
    fn absent_timestamp_field_still_falls_back_to_now() {
        let payload = r#"[{"email":"a@x.com","name":"A"}]"#;
        let out = normalize(&json_cfg(), payload, 42).unwrap();
        assert_eq!(out.records[0].updated_at, 42);
    }

    #[test]
    fn null_and_float_natural_keys_reject() {
        let payload = r#"[{"email":null,"name":"A"},{"email":1.5,"name":"B"},{"email":true,"name":"C"},{"email":7,"name":"D"}]"#;
        let out = normalize(&json_cfg(), payload, 0).unwrap();
        assert_eq!(out.records.len(), 1);
        assert_eq!(out.records[0].natural_key, "7");
        assert_eq!(out.rejects.len(), 3);
        for (_, reason) in &out.rejects {
            assert!(reason.contains("invalid natural key"), "{reason}");
        }
    }

    #[test]
    fn integral_floats_canonicalize_in_values() {
        let payload = r#"[{"email":"a@x.com","balance":1000.0,"rate":0.5,"count":7}]"#;
        let cfg = SourceConfig { timestamp_field: None, ..json_cfg() };
        let out = normalize(&cfg, payload, 0).unwrap();
        let f = &out.records[0].fields;
        assert_eq!(f["balance"], "1000");
        assert_eq!(f["rate"], "0.5");
        assert_eq!(f["count"], "7");
    }

    #[test]
    fn csv_bad_rows_are_rejects() {
        let payload = "email,name\na@x.com,Ann\nonly-one-column\n,MissingEmail\n";
        let out = normalize(&csv_cfg(), payload, 0).unwrap();
        assert_eq!(out.records.len(), 1);
        assert_eq!(out.rejects.len(), 2);
    }

    // Audit S3: the quarantined fragment must be the original raw line, not a
    // dequoted re-join that destroys embedded commas/quotes/newlines.
    #[test]
    fn csv_dead_letter_fragment_preserves_raw_line() {
        let payload = "email,name\na@x.com,\"likes, commas\",extra\nb@x.com,Bob\n";
        let out = normalize(&csv_cfg(), payload, 0).unwrap();
        assert_eq!(out.records.len(), 1);
        assert_eq!(out.rejects.len(), 1);
        assert_eq!(out.rejects[0].0, "a@x.com,\"likes, commas\",extra");
    }

    #[test]
    fn csv_dead_letter_fragment_preserves_quoted_newline() {
        let payload = "email,name\na@x.com,\"line1\nline2\",extra\n";
        let out = normalize(&csv_cfg(), payload, 0).unwrap();
        assert_eq!(out.rejects.len(), 1);
        assert_eq!(out.rejects[0].0, "a@x.com,\"line1\nline2\",extra");
    }

    // Audit F10: duplicate header names silently let the last column win — if
    // that column is the key or timestamp, the wrong data drives merging.
    #[test]
    fn duplicate_csv_headers_fail_the_batch() {
        let payload = "email,name,name\na@x.com,Ann,Anne\n";
        let err = normalize(&csv_cfg(), payload, 0).unwrap_err();
        assert!(err.to_string().contains("duplicate CSV header 'name'"), "{err}");
    }
}
