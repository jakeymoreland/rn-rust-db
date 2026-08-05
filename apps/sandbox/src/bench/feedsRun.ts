// Betting-feed scenarios: the workload the engine is positioned for.
//
// Unlike the CRM phases, these are shaped like a real price feed — a large
// collection of selections, a small slice moving per tick, several sources with
// meaningful priorities, and a market that closes by ceasing to arrive.
import { ingest, redis, registerSource } from '@rn-experiments/reconcile-engine';
import { FEED_SOURCES, selectionRows, suspensionRows, tickRows } from './feeds';
import { median, p95, sleep } from './harness';

export type FeedResult = { name: string; detail: string; pass?: boolean };

const SNAPSHOT = 5000; // selections in the book
const MOVED_PER_TICK = 50; // ~1% — the realistic steady state
const TICKS = 40;

export async function runFeeds(onProgress: (m: string) => void): Promise<FeedResult[]> {
  const out: FeedResult[] = [];
  for (const cfg of FEED_SOURCES) {
    await registerSource(cfg);
  }

  // ── 1. Cold snapshot: the whole book arrives once ──────────────────────────
  onProgress(`snapshot: ${SNAPSHOT} selections...`);
  const snapshot = selectionRows(SNAPSHOT);
  const bytes = snapshot.length;
  const t0 = performance.now();
  const snap = await ingest('feed_primary', snapshot);
  const snapMs = performance.now() - t0;
  out.push({
    name: 'cold snapshot',
    detail:
      `${SNAPSHOT} selections in ${snapMs.toFixed(0)} ms ` +
      `(${(bytes / 1024).toFixed(0)} KB, ${Math.round(bytes / SNAPSHOT)} B/row, ` +
      `${((snapMs * 1000) / SNAPSHOT).toFixed(0)} µs/row), inserted ${snap.inserted}`,
  });

  // ── 2. Tick waves: ~1% of the book moves, repeatedly ───────────────────────
  // The steady state. Most rows are unchanged, so the per-row content-hash
  // short-circuit should carry the batch, and changed_keys should name exactly
  // the rows that moved.
  onProgress(`${TICKS} tick waves, ${MOVED_PER_TICK} of ${SNAPSHOT} moving...`);
  const tickMs: number[] = [];
  const keyCounts: number[] = [];
  for (let rev = 1; rev <= TICKS; rev++) {
    const payload = tickRows(SNAPSHOT, MOVED_PER_TICK, rev);
    const t = performance.now();
    const s = await ingest('feed_primary', payload);
    tickMs.push(performance.now() - t);
    keyCounts.push(s.changed_keys?.selections?.length ?? 0);
    await sleep(0);
  }
  out.push({
    name: 'tick wave',
    detail:
      `${MOVED_PER_TICK}/${SNAPSHOT} moved: ${median(tickMs).toFixed(2)} ms median, ` +
      `p95 ${p95(tickMs).toFixed(2)} ms; changed_keys named ${median(keyCounts)} rows/tick`,
    pass: median(keyCounts) > 0 && median(keyCounts) <= MOVED_PER_TICK,
  });

  // ── 3. Priority: a desk suspension must beat a concurrent price tick ───────
  // The thing no single-backend sync engine can express. The desk publishes
  // only `status`; the feed keeps publishing prices. Per-field merge means the
  // desk owns status without owning prices.
  onProgress('trading desk suspends 20 markets mid-tick...');
  const suspendRev = TICKS + 5;
  await Promise.all([
    ingest('feed_primary', tickRows(SNAPSHOT, MOVED_PER_TICK, suspendRev)),
    ingest('trading_desk', suspensionRows(20, suspendRev)),
  ]);
  const suspended = await redis.hgetall('entry:selections:1.2000000-MATCH_ODDS-47000');
  out.push({
    name: 'desk suspension beats price tick',
    detail:
      `status=${suspended.status ?? '(none)'}, back_price=${suspended.back_price ?? '(none)'} ` +
      `— desk owns status, feed still owns price`,
    pass: suspended.status === 'SUSPENDED' && suspended.back_price !== undefined,
  });

  // ── 4. Secondary feed fills a gap without clobbering the primary ───────────
  onProgress('secondary feed publishes a stale price...');
  const stale = await ingest('feed_secondary', tickRows(SNAPSHOT, 10, 1));
  const afterStale = await redis.hgetall('entry:selections:1.2000000-MATCH_ODDS-47000');
  out.push({
    name: 'stale secondary loses on recency',
    detail: `secondary ingest: updated ${stale.updated}, unchanged ${stale.unchanged}; ` +
      `status still ${afterStale.status ?? '(none)'}`,
    pass: afterStale.status === 'SUSPENDED',
  });

  // ── 5. Re-poll with nothing moved ─────────────────────────────────────────
  onProgress('re-poll, nothing moved...');
  const same = tickRows(SNAPSHOT, MOVED_PER_TICK, TICKS);
  await ingest('feed_primary', same);
  const t2 = performance.now();
  const repoll = await ingest('feed_primary', same);
  const repollMs = performance.now() - t2;
  out.push({
    name: 'unchanged re-poll',
    detail: `${repollMs.toFixed(2)} ms${repoll.skipped ? ' (whole-payload skip)' : ''}, ` +
      `updated ${repoll.updated}, unchanged ${repoll.unchanged}`,
  });

  // ── 6. Market close: the row simply stops arriving ────────────────────────
  // Expected to FAIL today. Deletes are soft-delete + filter only, with no
  // tombstone reconciliation, so a market that closes by disappearing from the
  // feed stays in the book forever. This is the top functional gap for every
  // feed-driven use case and it is better demonstrated than described.
  onProgress('market close (row stops arriving)...');
  const closedKey = '1.2000000-TOTAL_GOALS-47000';
  const before = await redis.hgetall(`entry:selections:${closedKey}`);
  await ingest('feed_primary', tickRows(SNAPSHOT, MOVED_PER_TICK, TICKS + 10));
  const after = await redis.hgetall(`entry:selections:${closedKey}`);
  const stillThere = Object.keys(after).length > 0;
  out.push({
    name: 'market close (no tombstones)',
    detail: stillThere
      ? `row still present after ceasing to arrive (status=${after.status ?? '?'}) — ` +
        `feeds signal removal by omission and the engine has no way to express it`
      : `row removed (unexpected — tombstones may have landed)`,
    pass: !stillThere,
  });
  void before;

  return out;
}

export function renderFeeds(results: FeedResult[]): string {
  return results
    .map((r) => {
      const mark = r.pass === undefined ? ' ' : r.pass ? '✓' : '✗';
      return `${mark} ${r.name}\n  ${r.detail}`;
    })
    .join('\n');
}
