use crate::engine::Engine;
use crate::error::EngineError;
use crate::{commands, normalize::SourceConfig};
use serde_json::{json, Value};

fn ok(value: Value) -> String {
    json!({"ok": true, "value": value}).to_string()
}

fn err(e: &EngineError) -> String {
    json!({"ok": false, "code": e.code(), "message": e.to_string()}).to_string()
}

pub fn execute(engine: &mut Engine, request_json: &str) -> String {
    match run(engine, request_json) {
        Ok(v) => ok(v),
        Err(e) => err(&e),
    }
}

fn arg(args: &[String], i: usize) -> Result<&str, EngineError> {
    args.get(i)
        .map(|s| s.as_str())
        .ok_or_else(|| EngineError::Command(format!("missing argument {i}")))
}

fn run(engine: &mut Engine, request_json: &str) -> Result<Value, EngineError> {
    let req: Value = serde_json::from_str(request_json)
        .map_err(|e| EngineError::Command(format!("bad request: {e}")))?;
    let cmd = req["cmd"]
        .as_str()
        .ok_or_else(|| EngineError::Command("missing cmd".into()))?
        .to_string();
    let args: Vec<String> = req["args"]
        .as_array()
        .map(|a| {
            a.iter()
                .map(|v| v.as_str().map(str::to_string).unwrap_or_else(|| v.to_string()))
                .collect()
        })
        .unwrap_or_default();
    let now = engine.now();

    match cmd.as_str() {
        "get" => Ok(json!(commands::get(engine, arg(&args, 0)?, now)?)),
        "set" => {
            commands::set(engine, arg(&args, 0)?, arg(&args, 1)?)?;
            Ok(json!("OK"))
        }
        "del" => Ok(json!(commands::del(engine, arg(&args, 0)?)?)),
        "mget" => Ok(json!(commands::mget(engine, &args, now)?)),
        "scan" => Ok(json!(commands::scan(engine, arg(&args, 0)?, now)?)),
        "hget" => Ok(json!(commands::hget(&engine.store, arg(&args, 0)?, arg(&args, 1)?, now)?)),
        "hset" => {
            commands::hset(&engine.store, arg(&args, 0)?, arg(&args, 1)?, arg(&args, 2)?)?;
            // hset clears the key's TTL row; keep the cache's mirror in sync
            engine.kv.ttl.remove(arg(&args, 0)?);
            Ok(json!("OK"))
        }
        "hgetall" => Ok(json!(commands::hgetall(&engine.store, arg(&args, 0)?, now)?)),
        "expire" => {
            let ttl_ms: i64 = arg(&args, 1)?
                .parse()
                .map_err(|_| EngineError::Command("ttl must be integer ms".into()))?;
            commands::expire(engine, arg(&args, 0)?, ttl_ms, now)?;
            Ok(json!("OK"))
        }
        "ttl" => Ok(json!(commands::ttl(engine, arg(&args, 0)?, now)?)),
        "kvFlush" => {
            let pending = engine.kv.pending.len();
            engine.flush_kv()?;
            Ok(json!(pending))
        }
        "kvConfig" => {
            // [high_water, coalesce("0"|"1")] — benchmark knob; flushes first
            // so a config change never reorders already-queued writes.
            engine.flush_kv()?;
            let hw: usize = arg(&args, 0)?
                .parse()
                .map_err(|_| EngineError::Command("high_water must be an integer".into()))?;
            engine.kv.high_water = hw.max(1);
            engine.kv.coalesce = arg(&args, 1)? == "1";
            Ok(json!("OK"))
        }
        "subscribe" => Ok(json!(engine.pubsub.subscribe(arg(&args, 0)?))),
        "unsubscribe" => {
            let id: u64 = arg(&args, 0)?
                .parse()
                .map_err(|_| EngineError::Command("id must be integer".into()))?;
            Ok(json!(engine.pubsub.unsubscribe(id)))
        }
        "registerSource" => {
            let cfg: SourceConfig = serde_json::from_str(arg(&args, 0)?)
                .map_err(|e| EngineError::Command(format!("bad source config: {e}")))?;
            // Audit S5: ':' in a collection name corrupts the
            // entry:{collection}:{key} namespace (hgetall splits on the first
            // ':'), and an empty name produces unreadable keys.
            if cfg.collection.is_empty() || cfg.collection.contains(':') {
                return Err(EngineError::Command(format!(
                    "invalid collection name '{}' (must be non-empty, no ':')",
                    cfg.collection
                )));
            }
            engine.sources.insert(cfg.source_id.clone(), cfg);
            Ok(json!("OK"))
        }
        "deadLetterClear" => {
            let n = match args.first() {
                Some(src) => engine
                    .store
                    .conn
                    .execute("DELETE FROM dead_letter WHERE source = ?1", rusqlite::params![src])?,
                None => engine.store.conn.execute("DELETE FROM dead_letter", [])?,
            };
            Ok(json!(n))
        }
        "ingest" => {
            let (summary, skipped) = engine.ingest(arg(&args, 0)?, arg(&args, 1)?)?;
            let mut v = serde_json::to_value(&summary).unwrap();
            v["skipped"] = json!(skipped);
            Ok(v)
        }
        "ingestFile" => {
            let (summary, skipped) = engine.ingest_file(arg(&args, 0)?, arg(&args, 1)?)?;
            let mut v = serde_json::to_value(&summary).unwrap();
            v["skipped"] = json!(skipped);
            Ok(v)
        }
        "deadLetterCount" => {
            let n: i64 = engine
                .store
                .conn
                .query_row("SELECT count(*) FROM dead_letter", [], |r| r.get(0))?;
            Ok(json!(n))
        }
        other => Err(EngineError::Command(format!("unknown command '{other}'"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::Engine;

    fn eng() -> Engine {
        Engine::open(":memory:", Box::new(|| 1000)).unwrap()
    }

    fn ok_value(resp: &str) -> serde_json::Value {
        let v: serde_json::Value = serde_json::from_str(resp).unwrap();
        assert_eq!(v["ok"], true, "expected ok response, got {resp}");
        v["value"].clone()
    }

    #[test]
    fn coalescing_and_config_via_dispatch() {
        let mut e = eng();
        // coalesce on (default): 300 sets over 30 keys pend as 30 slots
        for i in 0..300 {
            ok_value(&execute(&mut e, &format!(r#"{{"cmd":"set","args":["ck{}","v{i}"]}}"#, i % 30)));
        }
        assert_eq!(e.kv.pending.len(), 30);
        let flushed = ok_value(&execute(&mut e, r#"{"cmd":"kvFlush","args":[]}"#));
        assert_eq!(flushed, 30);
        // last write wins
        assert_eq!(ok_value(&execute(&mut e, r#"{"cmd":"get","args":["ck0"]}"#)), "v270");
        // coalesce off: every set pends
        ok_value(&execute(&mut e, r#"{"cmd":"kvConfig","args":["100000","0"]}"#));
        for i in 0..300 {
            ok_value(&execute(&mut e, &format!(r#"{{"cmd":"set","args":["ck{}","w{i}"]}}"#, i % 30)));
        }
        assert_eq!(e.kv.pending.len(), 300);
        let flushed = ok_value(&execute(&mut e, r#"{"cmd":"kvFlush","args":[]}"#));
        assert_eq!(flushed, 300);
        assert_eq!(ok_value(&execute(&mut e, r#"{"cmd":"get","args":["ck0"]}"#)), "w270");
        // low high-water auto-flushes
        ok_value(&execute(&mut e, r#"{"cmd":"kvConfig","args":["4","1"]}"#));
        for i in 0..10 {
            ok_value(&execute(&mut e, &format!(r#"{{"cmd":"set","args":["hw{i}","x"]}}"#)));
        }
        assert!(e.kv.pending.len() < 4, "auto-flush at high_water=4 did not fire");
    }

    #[test]
    fn ingest_reports_timing_breakdown() {
        let mut e = eng();
        ok_value(&execute(&mut e, r#"{"cmd":"registerSource","args":["{\"source_id\":\"api\",\"format\":\"Json\",\"collection\":\"people\",\"natural_key_field\":\"email\",\"timestamp_field\":null,\"priority\":10}"]}"#));
        let payload = r#"[{"email":"t@x.com","name":"T"}]"#;
        let v = ok_value(&execute(&mut e, &format!(
            r#"{{"cmd":"ingest","args":["api",{}]}}"#,
            serde_json::to_string(payload).unwrap()
        )));
        let t = &v["timings"];
        assert!(t["parse_ms"].is_number(), "missing timings: {v}");
        assert!(t["merge_ms"].is_number());
        assert!(t["commit_ms"].is_number());
    }

    #[test]
    fn set_get_via_dispatch() {
        let mut e = eng();
        ok_value(&execute(&mut e, r#"{"cmd":"set","args":["a","1"]}"#));
        assert_eq!(ok_value(&execute(&mut e, r#"{"cmd":"get","args":["a"]}"#)), "1");
        assert!(ok_value(&execute(&mut e, r#"{"cmd":"get","args":["nope"]}"#)).is_null());
    }

    #[test]
    fn unknown_command_is_error_envelope() {
        let mut e = eng();
        let v: serde_json::Value =
            serde_json::from_str(&execute(&mut e, r#"{"cmd":"flushall","args":[]}"#)).unwrap();
        assert_eq!(v["ok"], false);
        assert_eq!(v["code"], 4);
    }

    #[test]
    fn malformed_request_is_error_envelope_not_panic() {
        let mut e = eng();
        let v: serde_json::Value = serde_json::from_str(&execute(&mut e, "{nope")).unwrap();
        assert_eq!(v["ok"], false);
    }

    #[test]
    fn register_source_and_ingest_publishes_changes() {
        let mut e = eng();
        let seen = std::sync::Arc::new(std::sync::Mutex::new(vec![]));
        let s2 = seen.clone();
        e.pubsub.set_sink(Box::new(move |ch, _| s2.lock().unwrap().push(ch.to_string())));
        let cfg = r#"{"source_id":"api","format":"Json","collection":"people","natural_key_field":"email","timestamp_field":null,"priority":10}"#;
        ok_value(&execute(&mut e, &format!(
            r#"{{"cmd":"registerSource","args":[{}]}}"#,
            serde_json::to_string(cfg).unwrap()
        )));
        ok_value(&execute(&mut e, r#"{"cmd":"subscribe","args":["changes:*"]}"#));
        let payload = r#"[{"email":"a@x.com","name":"Ann"}]"#;
        let summary = ok_value(&execute(&mut e, &format!(
            r#"{{"cmd":"ingest","args":["api",{}]}}"#,
            serde_json::to_string(payload).unwrap()
        )));
        assert_eq!(summary["inserted"], 1);
        assert_eq!(seen.lock().unwrap().as_slice(), ["changes:people"]);
        // read back through redis surface
        let h = ok_value(&execute(&mut e, r#"{"cmd":"hgetall","args":["entry:people:a@x.com"]}"#));
        assert_eq!(h["name"], "Ann");
    }

    #[test]
    fn duplicate_ingest_is_skipped_by_content_hash() {
        let mut e = eng();
        let cfg = r#"{"source_id":"api","format":"Json","collection":"people","natural_key_field":"email","timestamp_field":null,"priority":10}"#;
        ok_value(&execute(&mut e, &format!(
            r#"{{"cmd":"registerSource","args":[{}]}}"#,
            serde_json::to_string(cfg).unwrap()
        )));
        let payload = r#"[{"email":"a@x.com","name":"Ann"}]"#;
        let req = format!(
            r#"{{"cmd":"ingest","args":["api",{}]}}"#,
            serde_json::to_string(payload).unwrap()
        );
        let first = ok_value(&execute(&mut e, &req));
        assert_eq!(first["inserted"], 1);
        let second = ok_value(&execute(&mut e, &req));
        assert_eq!(second["inserted"], 0);
        assert_eq!(second["skipped"], true);
    }

    // Audit S5: ':' in a collection name corrupts the entry:{collection}:{key}
    // namespace (hgetall splits on the first ':'), so registration rejects it.
    #[test]
    fn register_source_rejects_colon_and_empty_collection() {
        let mut e = eng();
        for bad in ["crm:people", ""] {
            let cfg = format!(
                r#"{{"source_id":"api","format":"Json","collection":"{bad}","natural_key_field":"id","timestamp_field":null,"priority":10}}"#
            );
            let v: serde_json::Value = serde_json::from_str(&execute(
                &mut e,
                &format!(r#"{{"cmd":"registerSource","args":[{}]}}"#, serde_json::to_string(&cfg).unwrap()),
            ))
            .unwrap();
            assert_eq!(v["ok"], false, "collection {bad:?} was accepted");
            assert_eq!(v["code"], 4);
        }
    }

    // Audit S13: deadLetterClear drains the quarantine.
    #[test]
    fn dead_letter_clear_command() {
        let mut e = eng();
        let cfg = r#"{"source_id":"api","format":"Json","collection":"people","natural_key_field":"email","timestamp_field":null,"priority":10}"#;
        ok_value(&execute(&mut e, &format!(
            r#"{{"cmd":"registerSource","args":[{}]}}"#,
            serde_json::to_string(cfg).unwrap()
        )));
        let payload = r#"[{"name":"NoKey1"},{"name":"NoKey2"}]"#;
        ok_value(&execute(&mut e, &format!(
            r#"{{"cmd":"ingest","args":["api",{}]}}"#,
            serde_json::to_string(payload).unwrap()
        )));
        assert_eq!(ok_value(&execute(&mut e, r#"{"cmd":"deadLetterCount","args":[]}"#)), 2);
        let cleared = ok_value(&execute(&mut e, r#"{"cmd":"deadLetterClear","args":[]}"#));
        assert_eq!(cleared, 2);
        assert_eq!(ok_value(&execute(&mut e, r#"{"cmd":"deadLetterCount","args":[]}"#)), 0);
    }

    #[test]
    fn ingest_unknown_source_is_source_error() {
        let mut e = eng();
        let v: serde_json::Value = serde_json::from_str(&execute(
            &mut e,
            r#"{"cmd":"ingest","args":["ghost","[]"]}"#,
        ))
        .unwrap();
        assert_eq!(v["ok"], false);
        assert_eq!(v["code"], 3);
    }
}
