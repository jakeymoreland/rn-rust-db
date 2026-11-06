//! Order-independent merge. The same multiset of timestamped updates and
//! deletes must land on one visible state no matter the arrival order.
use std::collections::BTreeMap;

use proptest::prelude::*;
use reconcile_engine::commands;
use reconcile_engine::normalize::{CanonicalRecord, NormalizeOutcome, SourceConfig, SourceFormat};
use reconcile_engine::reconcile::reconcile;
use reconcile_engine::store::Store;

#[derive(Clone, Debug)]
struct Op {
    source: u8,
    priority: u32,
    ts: i64,
    key: u8,
    value: u8,
    deleted: bool,
}

fn source_name(id: u8) -> &'static str {
    match id % 3 {
        0 => "api",
        1 => "feed",
        _ => "desk",
    }
}

fn apply(st: &mut Store, op: &Op) {
    let key = format!("k{}", op.key % 3);
    let mut fields = BTreeMap::new();
    fields.insert("id".into(), key.clone());
    if !op.deleted {
        fields.insert("v".into(), format!("v{}", op.value % 5));
    }
    let rec = CanonicalRecord {
        collection: "c".into(),
        natural_key: key,
        source: source_name(op.source).into(),
        fields,
        updated_at: op.ts,
        logical: 0,
        timestamped: true,
        deleted: op.deleted,
    };
    let cfg = SourceConfig {
        source_id: source_name(op.source).into(),
        format: SourceFormat::Json,
        collection: "c".into(),
        natural_key_field: "id".into(),
        timestamp_field: Some("ts".into()),
        priority: op.priority,
        snapshot: false,
    };
    reconcile(
        st,
        &cfg,
        NormalizeOutcome { records: vec![rec], rejects: vec![] },
        0,
        "h",
    )
    .unwrap();
}

fn dump(st: &Store) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for key in ["k0", "k1", "k2"] {
        let h = commands::hgetall(st, &format!("entry:c:{key}"), 0).unwrap();
        let name = h.get("v").cloned().unwrap_or_default();
        out.push((key.into(), name));
    }
    out
}

fn arb_op() -> impl Strategy<Value = Op> {
    (0u8..3, 1u32..4, 0i64..6, 0u8..3, 0u8..5, prop::bool::ANY).prop_map(
        |(source, priority, ts, key, value, deleted)| Op {
            source,
            priority,
            ts,
            key,
            value,
            deleted,
        },
    )
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(48))]

    #[test]
    fn merge_converges_under_reversal(ops in prop::collection::vec(arb_op(), 0..10)) {
        let mut forward = Store::open(":memory:").unwrap();
        let mut backward = Store::open(":memory:").unwrap();
        for op in &ops {
            apply(&mut forward, op);
        }
        for op in ops.iter().rev() {
            apply(&mut backward, op);
        }
        prop_assert_eq!(dump(&forward), dump(&backward));

        // Applying the batch again is a no-op on the visible state.
        for op in &ops {
            apply(&mut forward, op);
        }
        prop_assert_eq!(dump(&forward), dump(&backward));
    }
}
