use crate::glob::glob_match;

pub type Sink = Box<dyn Fn(&str, &str) + Send>;

struct Sub {
    id: u64,
    pattern: String,
}

pub struct PubSub {
    subs: Vec<Sub>,
    next_id: u64,
    sink: Option<Sink>,
}

impl PubSub {
    pub fn new() -> PubSub {
        PubSub { subs: vec![], next_id: 1, sink: None }
    }

    pub fn set_sink(&mut self, sink: Sink) {
        self.sink = Some(sink);
    }

    pub fn subscribe(&mut self, pattern: &str) -> u64 {
        let id = self.next_id;
        self.next_id += 1;
        self.subs.push(Sub { id, pattern: pattern.to_string() });
        id
    }

    pub fn unsubscribe(&mut self, id: u64) -> bool {
        let before = self.subs.len();
        self.subs.retain(|s| s.id != id);
        self.subs.len() != before
    }

    pub fn publish(&self, channel: &str, payload: &str) -> u32 {
        let matches = self
            .subs
            .iter()
            .filter(|s| glob_match(&s.pattern, channel))
            .count() as u32;
        if matches > 0 {
            if let Some(sink) = &self.sink {
                sink(channel, payload);
            }
        }
        matches
    }

    /// Whether any active subscription matches this channel. Used to decide
    /// which change events to buffer for delivery AFTER the engine lock is
    /// released (audit S7) — the sink itself is invoked by the FFI layer.
    pub fn any_match(&self, channel: &str) -> bool {
        self.subs.iter().any(|s| glob_match(&s.pattern, channel))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    fn recording_pubsub() -> (PubSub, Arc<Mutex<Vec<(String, String)>>>) {
        let mut ps = PubSub::new();
        let log: Arc<Mutex<Vec<(String, String)>>> = Arc::new(Mutex::new(vec![]));
        let l2 = log.clone();
        ps.set_sink(Box::new(move |ch, payload| {
            l2.lock().unwrap().push((ch.to_string(), payload.to_string()));
        }));
        (ps, log)
    }

    #[test]
    fn publish_reaches_matching_pattern_once() {
        let (mut ps, log) = recording_pubsub();
        ps.subscribe("changes:*");
        ps.subscribe("changes:people"); // second match must not double-fire sink
        let n = ps.publish("changes:people", "{}");
        assert_eq!(n, 2);
        assert_eq!(log.lock().unwrap().len(), 1);
        assert_eq!(log.lock().unwrap()[0].0, "changes:people");
    }

    #[test]
    fn no_match_no_sink() {
        let (mut ps, log) = recording_pubsub();
        ps.subscribe("changes:people");
        assert_eq!(ps.publish("changes:orders", "{}"), 0);
        assert!(log.lock().unwrap().is_empty());
    }

    #[test]
    fn unsubscribe_stops_delivery() {
        let (mut ps, log) = recording_pubsub();
        let id = ps.subscribe("changes:*");
        assert!(ps.unsubscribe(id));
        assert!(!ps.unsubscribe(id));
        ps.publish("changes:people", "{}");
        assert!(log.lock().unwrap().is_empty());
    }
}
