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
            engine.sources.insert(cfg.source_id.clone(), cfg);
            Ok(json!("OK"))
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
