//! Hybrid logical clock for merge versions.
//!
//! Source timestamps drive last-writer-wins when a feed supplies them. They are
//! clamped to `local + skew_bound` once the local wall clock looks real (at or
//! after 2020-01-01), so a feed whose clock is hours ahead cannot lock every
//! other source out for the rest of the day. Records with no timestamp are
//! stamped from this clock instead of the raw wall clock: the physical
//! component never moves backwards, and the logical component orders events
//! that share a millisecond.
//!
//! The stamp stored on a field is a pure function of the record plus this
//! clock's skew clamp. Tie-breaking above the stamp (priority, source id,
//! value) lives in the merge and does not depend on arrival order.

use crate::error::EngineError;
use crate::normalize::CanonicalRecord;
use rusqlite::{params, Connection, OptionalExtension};

/// Wall-clock values below this are treated as test/unset clocks and do not
/// arm the skew clamp. 2020-01-01T00:00:00Z.
pub const SKEW_ARM_EPOCH_MS: i64 = 1_577_836_800_000;

/// A source timestamp may sit at most this far ahead of the local reference.
pub const DEFAULT_SKEW_BOUND_MS: i64 = 300_000;

/// Tombstones younger than this are kept so a late update can still lose to
/// them. Compaction also refuses to drop anything inside the skew window.
pub const DEFAULT_TOMBSTONE_TTL_MS: i64 = 7 * 24 * 60 * 60 * 1000;

#[derive(Clone, Debug)]
pub struct HybridClock {
    pub physical: i64,
    pub logical: u64,
    /// False until the first stamp. Distinguishes "never issued" from a real
    /// stamp at physical 0.
    pub started: bool,
    pub skew_bound_ms: i64,
    pub tombstone_ttl_ms: i64,
}

impl Default for HybridClock {
    fn default() -> Self {
        Self {
            physical: 0,
            logical: 0,
            started: false,
            skew_bound_ms: DEFAULT_SKEW_BOUND_MS,
            tombstone_ttl_ms: DEFAULT_TOMBSTONE_TTL_MS,
        }
    }
}

impl HybridClock {
    pub fn load(conn: &Connection) -> Result<Self, EngineError> {
        let mut clock = Self::default();
        clock.apply_env();
        let row: Option<(i64, i64)> = conn
            .query_row(
                "SELECT physical, logical FROM clock_state WHERE id = 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        if let Some((physical, logical)) = row {
            clock.physical = physical;
            clock.logical = logical.max(0) as u64;
            clock.started = true;
        }
        Ok(clock)
    }

    pub fn apply_env(&mut self) {
        if let Some(v) = env_i64("RECONCILE_MAX_SKEW_MS") {
            if v >= 0 {
                self.skew_bound_ms = v;
            }
        }
        if let Some(v) = env_i64("RECONCILE_TOMBSTONE_TTL_MS") {
            if v >= 0 {
                self.tombstone_ttl_ms = v;
            }
        }
    }

    pub fn persist(&self, conn: &Connection) -> Result<(), EngineError> {
        if !self.started {
            return Ok(());
        }
        conn.execute(
            "INSERT INTO clock_state(id, physical, logical) VALUES (1, ?1, ?2)
             ON CONFLICT(id) DO UPDATE SET physical = excluded.physical, logical = excluded.logical",
            params![self.physical, self.logical as i64],
        )?;
        Ok(())
    }

    /// Issue the next local stamp. A wall clock that jumps backwards does not
    /// produce a stamp that sorts before one already issued.
    pub fn tick(&mut self, wall: i64) -> (i64, u64) {
        if !self.started {
            self.started = true;
            self.physical = wall;
            self.logical = 0;
            return (self.physical, 0);
        }
        let physical = wall.max(self.physical);
        if physical == self.physical {
            self.logical = self.logical.saturating_add(1);
        } else {
            self.physical = physical;
            self.logical = 0;
        }
        (self.physical, self.logical)
    }

    /// Accept a source timestamp. Returns `(physical, clamped)`.
    pub fn accept_remote(&mut self, source_ts: i64, wall: i64) -> (i64, bool) {
        let reference = if self.started {
            wall.max(self.physical)
        } else {
            wall
        };
        let armed = wall >= SKEW_ARM_EPOCH_MS || (self.started && self.physical >= SKEW_ARM_EPOCH_MS);
        let limit = reference.saturating_add(self.skew_bound_ms);
        let (physical, clamped) = if armed && source_ts > limit {
            (limit, true)
        } else {
            (source_ts, false)
        };
        if !self.started || physical > self.physical {
            self.physical = physical;
            self.logical = 0;
            self.started = true;
        }
        (physical, clamped)
    }

    /// How far back compaction may reach. Never inside the skew window, and
    /// never younger than the tombstone TTL.
    pub fn compaction_cutoff(&self, now_ms: i64) -> Option<i64> {
        let retain = self.tombstone_ttl_ms.max(self.skew_bound_ms);
        if retain < 0 || now_ms <= retain {
            return None;
        }
        Some(now_ms - retain)
    }
}

fn env_i64(key: &str) -> Option<i64> {
    std::env::var(key).ok().and_then(|v| v.parse().ok())
}

/// Stamp `records` in place. Source timestamps are clamped; missing timestamps
/// take a fresh tick so later rows in the batch sort after earlier ones.
/// Returns how many source timestamps were clamped.
pub fn stamp_records(clock: &mut HybridClock, records: &mut [CanonicalRecord], wall: i64) -> u32 {
    let mut clamped = 0u32;
    for rec in records.iter_mut() {
        if rec.timestamped {
            let (physical, was_clamped) = clock.accept_remote(rec.updated_at, wall);
            rec.updated_at = physical;
            if was_clamped {
                clamped = clamped.saturating_add(1);
            }
        } else {
            let (physical, logical) = clock.tick(wall);
            rec.updated_at = physical;
            rec.logical = logical;
        }
    }
    clamped
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tick_does_not_move_backwards_when_the_wall_clock_does() {
        let mut c = HybridClock::default();
        assert_eq!(c.tick(5_000), (5_000, 0));
        assert_eq!(c.tick(100), (5_000, 1));
        assert_eq!(c.tick(5_000), (5_000, 2));
        assert_eq!(c.tick(9_000), (9_000, 0));
    }

    #[test]
    fn remote_timestamp_is_clamped_only_when_the_clock_is_armed() {
        let mut c = HybridClock::default();
        let wall = 1_700_000_000_000;
        let (physical, clamped) = c.accept_remote(wall + 10 * 24 * 60 * 60 * 1000, wall);
        assert!(clamped);
        assert_eq!(physical, wall + DEFAULT_SKEW_BOUND_MS);

        // An unset/test clock must not collapse real source timestamps.
        let mut unset = HybridClock::default();
        let (physical, clamped) = unset.accept_remote(1_700_000_000_000, 0);
        assert!(!clamped);
        assert_eq!(physical, 1_700_000_000_000);
    }

    #[test]
    fn observing_a_remote_stamp_does_not_decrease_the_logical_counter() {
        let mut c = HybridClock::default();
        c.tick(1_000);
        c.tick(1_000);
        assert_eq!(c.logical, 1);
        let _ = c.accept_remote(1_000, 1_000);
        assert_eq!(c.logical, 1);
        assert_eq!(c.tick(1_000), (1_000, 2));
    }
}
