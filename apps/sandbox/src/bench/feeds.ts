// --- Betting-feed shape: the workload this engine is actually for. ---
//
// The CRM shape in data.ts rewrites EVERY field of EVERY row on each update
// wave, which is a worst case that hides two things: the per-row content-hash
// short-circuit never fires, and the cost of rewriting a whole ~950 B `fields`
// blob to change one value never shows up as waste.
//
// A price feed is the opposite and is the realistic case: ~11 static fields
// that never move, ~7 volatile ones that tick, and only a small percentage of
// rows changing per tick. That is where "rewrite the entire fields JSON to
// change one price" becomes the dominant cost, and where the hash skip earns
// its keep.
//
// The natural key is the SELECTION (one runner in one market), because that is
// the thing that ticks and the thing a UI renders a row for.

export type FeedSource =
  | 'feed_primary'
  | 'feed_secondary'
  | 'trading_desk'
  | 'settlement';

/**
 * Four sources over the same selections, with priorities that mean something.
 *
 * This is the part no single-backend sync engine can express: a manual
 * suspension from the trading desk must beat an in-flight price tick from the
 * firehose, and a settlement must beat everything, permanently. Merge is
 * per field, so the desk can own `status` without owning prices.
 *
 * Every source dates its own records, because a source with
 * `timestamp_field: null` is stamped at ingest time and a slow-but-fresh feed
 * would then outrank a fast one. See the README's ordering rule.
 */
export const FEED_SOURCES = [
  {
    source_id: 'feed_primary',
    format: 'Json' as const,
    collection: 'selections',
    natural_key_field: 'selection_id',
    timestamp_field: 'updated_at',
    priority: 10,
  },
  {
    source_id: 'feed_secondary',
    format: 'Json' as const,
    collection: 'selections',
    natural_key_field: 'selection_id',
    timestamp_field: 'updated_at',
    priority: 5,
  },
  {
    source_id: 'trading_desk',
    format: 'Json' as const,
    collection: 'selections',
    natural_key_field: 'selection_id',
    timestamp_field: 'updated_at',
    priority: 20,
  },
  {
    source_id: 'settlement',
    format: 'Json' as const,
    collection: 'selections',
    natural_key_field: 'selection_id',
    timestamp_field: 'updated_at',
    priority: 30,
  },
];

const COMPETITIONS = [
  'Premier League', 'La Liga', 'Serie A', 'Bundesliga', 'A-League',
  'NRL', 'AFL', 'ATP Tour', 'NBA', 'Test Cricket',
];
const HOME = ['Arsenal', 'Barcelona', 'Juventus', 'Bayern', 'Sydney FC', 'Broncos', 'Carlton', 'Djokovic', 'Lakers', 'Australia'];
const AWAY = ['Chelsea', 'Real Madrid', 'Inter', 'Dortmund', 'Melbourne City', 'Storm', 'Collingwood', 'Alcaraz', 'Celtics', 'England'];
const MARKETS = ['Match Odds', 'Total Goals', 'Handicap', 'First Scorer', 'Correct Score'];

/** Deterministic pseudo-random in [0,1) so runs are reproducible. */
function rnd(seed: number): number {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

/** A price that looks like a price: 1.01–26.0, two decimals, tighter at the short end. */
function price(seed: number): number {
  const r = rnd(seed);
  return Math.round((1.01 + r * r * 25) * 100) / 100;
}

export type SelectionOpts = {
  /** Which tick this is — moves the volatile fields and `updated_at`. */
  rev?: number;
  /** Status override, e.g. a trading-desk suspension. */
  status?: 'ACTIVE' | 'SUSPENDED' | 'CLOSED' | 'REMOVED';
  /** Emit only the volatile fields + key, as a real delta feed would. */
  deltaOnly?: boolean;
};

/**
 * `count` selections starting at `startIndex`. Three selections per market
 * (home / draw / away shaped), so market and event ids repeat the way they do
 * in a real feed and a market suspension touches several keys at once.
 */
export function selectionRows(count: number, startIndex = 0, opts: SelectionOpts = {}): string {
  const { rev = 0, status, deltaOnly = false } = opts;
  const rows = new Array(count);
  for (let r = 0; r < count; r++) {
    const i = startIndex + r;
    const marketIdx = Math.floor(i / 3);
    const runnerIdx = i % 3;
    const eventIdx = Math.floor(marketIdx / MARKETS.length);
    const seed = i + rev * 1_000_003;

    const eventId = `1.${2000000 + eventIdx}`;
    const marketType = MARKETS[marketIdx % MARKETS.length];
    const marketId = `${eventId}-${marketType.replace(/ /g, '_').toUpperCase()}`;
    const selectionId = `${marketId}-${47000 + runnerIdx}`;
    // Prices tick every rev; sizes and matched volume drift with them.
    const back = price(seed);
    const lay = Math.round((back + 0.02 + rnd(seed + 1) * 0.06) * 100) / 100;
    const updatedAt = new Date(1785000000000 + rev * 250 + (i % 97)).toISOString();

    const volatile = {
      back_price: back,
      back_size: Math.round(rnd(seed + 2) * 5000 * 100) / 100,
      lay_price: lay,
      lay_size: Math.round(rnd(seed + 3) * 3000 * 100) / 100,
      last_traded_price: back,
      total_matched: Math.round(rnd(seed + 4) * 400000 * 100) / 100,
      updated_at: updatedAt,
    };

    if (deltaOnly) {
      rows[r] = { selection_id: selectionId, ...volatile, ...(status ? { status } : {}) };
      continue;
    }

    rows[r] = {
      selection_id: selectionId,
      // ── static: present on every full snapshot, never moves ──
      event_id: eventId,
      event_name: `${HOME[eventIdx % HOME.length]} v ${AWAY[eventIdx % AWAY.length]}`,
      competition: COMPETITIONS[eventIdx % COMPETITIONS.length],
      market_id: marketId,
      market_name: marketType,
      market_type: marketType.replace(/ /g, '_').toUpperCase(),
      start_time: new Date(1785600000000 + eventIdx * 3_600_000).toISOString(),
      runner_name: runnerIdx === 0 ? HOME[eventIdx % HOME.length] : runnerIdx === 1 ? 'Draw' : AWAY[eventIdx % AWAY.length],
      runner_id: 47000 + runnerIdx,
      sort_order: runnerIdx + 1,
      in_play: false,
      status: status ?? 'ACTIVE',
      // ── volatile ──
      ...volatile,
    };
  }
  return JSON.stringify(rows);
}

/**
 * A tick: `moved` of the first `total` selections get new prices, as a delta
 * feed would send them. This is the steady state — a small slice of a large
 * collection moving, repeatedly.
 */
export function tickRows(total: number, moved: number, rev: number): string {
  const stride = Math.max(1, Math.floor(total / moved));
  const rows = [];
  for (let i = 0; i < total && rows.length < moved; i += stride) {
    rows.push(JSON.parse(selectionRows(1, i, { rev, deltaOnly: true }))[0]);
  }
  return JSON.stringify(rows);
}

/**
 * A trading-desk suspension: every selection in `markets` markets goes
 * SUSPENDED. Few keys, highest priority, and it must win against whatever the
 * price feed is doing at the same moment.
 */
export function suspensionRows(markets: number, rev: number): string {
  const rows = [];
  for (let m = 0; m < markets; m++) {
    for (let runner = 0; runner < 3; runner++) {
      const i = m * 3 + runner;
      const row = JSON.parse(selectionRows(1, i, { rev, deltaOnly: true, status: 'SUSPENDED' }))[0];
      // The desk owns status only — it does not publish prices.
      rows.push({
        selection_id: row.selection_id,
        status: 'SUSPENDED',
        updated_at: row.updated_at,
      });
    }
  }
  return JSON.stringify(rows);
}
