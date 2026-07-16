import { ingest, registerSource, subscribe } from '@rn-experiments/reconcile-engine';

import { fastPath, frameStats, median, p95, sleep, startFrameMonitor } from './harness';
import { realisticRows } from './data';
import { createLazyEntryRows } from './decode';
import { setRealListVisible, waitForRealListDriver } from './RealAppList';

export type RealAppResult = { name: string; value: string };

// The "real data application" scenario: a LegendList screen backed by the
// engine using every best practice this project established — one zero-copy
// buffer per refresh, lazy row materialization (only visible rows become JS
// objects), rAF-paced scrolling, and live tick updates re-querying through
// the same path. This is what an actual product screen would do.
export async function runRealApp(onProgress: (msg: string) => void): Promise<RealAppResult[]> {
  const results: RealAppResult[] = [];
  const out = (name: string, value: string) => {
    results.push({ name, value });
    onProgress(`${name}: ${value}`);
  };
  const fp = fastPath();
  const query = () => createLazyEntryRows(fp.queryEntriesBuffer('bench_app'));

  await registerSource({
    source_id: 'bench_app',
    format: 'Json',
    collection: 'bench_app',
    natural_key_field: 'id',
    timestamp_field: null,
    priority: 1,
  });
  onProgress('seeding 10k rows...');
  await ingest('bench_app', realisticRows(10000, 980));
  onProgress('pre-building tick payloads...');
  const ticks = Array.from({ length: 60 }, (_, i) => realisticRows(10, 980, i + 1));

  setRealListVisible(true);
  try {
    const drv = await waitForRealListDriver(3000);
    if (!drv) {
      out('real-app list', 'driver unavailable — is the list route mounted?');
      return results;
    }

    // 1. cold hydrate: query -> lazy view -> committed on screen, x5
    const hydrate: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      await drv.setView(query());
      hydrate.push(performance.now() - t0);
      await sleep(50);
    }
    out('cold hydrate (10k rows -> painted)', `${median(hydrate).toFixed(1)} ms median of 5`);

    // 2. idle scroll baseline, 5 s
    let budgetMs = 1000 / 60;
    {
      drv.startScroll();
      const mon = startFrameMonitor();
      await sleep(5000);
      const deltas = mon.stop();
      drv.stopScroll();
      const med = median(deltas);
      budgetMs = 1000 / (med < 12 ? 120 : 60);
      const s = frameStats(deltas, budgetMs);
      out(
        'idle scroll (5 s, no updates)',
        `${s.effectiveFps.toFixed(1)} fps, dropped ${s.dropped}/${s.frames}, worst gap ${s.worstGapMs.toFixed(1)} ms`,
      );
    }

    await sleep(300);

    // 3. scroll + live ticks, 10 s: 10-row update every 200 ms, each wave
    // re-queried through the zero-copy lazy path and committed
    {
      const latencies: number[] = [];
      let evtResolve: (() => void) | null = null;
      const unsub = await subscribe('changes:bench_app', () => evtResolve?.());
      drv.startScroll();
      const mon = startFrameMonitor();
      const t0 = performance.now();
      let wave = 0;
      while (performance.now() - t0 < 10_000 && wave < ticks.length) {
        const evtP = new Promise<void>((res) => (evtResolve = res));
        const tw = performance.now();
        await ingest('bench_app', ticks[wave++]);
        await evtP;
        await drv.setView(query());
        latencies.push(performance.now() - tw);
        await sleep(Math.max(0, 200 - (performance.now() - tw)));
      }
      const s = frameStats(mon.stop(), budgetMs);
      drv.stopScroll();
      unsub();
      out(
        'scroll + live ticks (10 s, 10 rows/200 ms)',
        `${s.effectiveFps.toFixed(1)} fps, dropped ${s.dropped}/${s.frames}, worst gap ${s.worstGapMs.toFixed(1)} ms`,
      );
      out(
        'tick -> row painted',
        `${median(latencies).toFixed(1)} ms median, p95 ${p95(latencies).toFixed(1)} ms (${latencies.length} waves)`,
      );
    }
  } finally {
    setRealListVisible(false);
  }

  return results;
}

export function renderRealApp(results: RealAppResult[]): string {
  return results.map((r) => `${r.name}\n  ${r.value}`).join('\n');
}
