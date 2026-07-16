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
        other => other.to_string(),
    }
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
    let updated_at = cfg
        .timestamp_field
        .as_ref()
        .and_then(|tf| fields.get(tf))
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(now_ms);
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
fn parse_csv_rows(payload: &str) -> Vec<Vec<String>> {
    let mut rows: Vec<Vec<String>> = Vec::new();
    let mut row: Vec<String> = Vec::new();
    let mut field = String::new();
    let mut in_quotes = false;
    let mut chars = payload.chars().peekable();
    while let Some(c) = chars.next() {
        if in_quotes {
            match c {
                '"' => {
                    if chars.peek() == Some(&'"') {
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
                    rows.push(std::mem::take(&mut row));
                }
                _ => field.push(c),
            }
        }
    }
    if !field.is_empty() || !row.is_empty() {
        row.push(field);
        rows.push(row);
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
    let header = &rows[0];
    let mut out = NormalizeOutcome { records: vec![], rejects: vec![] };
    for row in &rows[1..] {
        let fragment = row.join(",");
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
    fn csv_bad_rows_are_rejects() {
        let payload = "email,name\na@x.com,Ann\nonly-one-column\n,MissingEmail\n";
        let out = normalize(&csv_cfg(), payload, 0).unwrap();
        assert_eq!(out.records.len(), 1);
        assert_eq!(out.rejects.len(), 2);
    }
}
