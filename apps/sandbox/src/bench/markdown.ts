import type { BenchResult } from './harness';
import { ANCHORS, BANDED_CATEGORIES, metricFrac } from './score';
import type { BenchmarkScore, BenchMetrics, CategoryScore } from './score';

export const CATEGORY_LABELS = {
  native: 'Native Calls',
  storage: 'Write Throughput',
  query: 'Query Throughput',
  interop: 'JS Interop',
  sync: 'Sync Engine',
  reliability: 'Reliability',
} as const;
export type CategoryKey = keyof typeof CATEGORY_LABELS;

export type RunOutput = {
  results: BenchResult[];
  metrics: BenchMetrics;
  score: BenchmarkScore;
};

const WIDTH = 34; // inner width between the ║ borders

function boxRow(label: string, pts: string): string {
  const body = ` ${label.padEnd(19)}${pts.padStart(9)}`;
  return `║${body.padEnd(WIDTH)}║`;
}

export function renderScorecard(s: BenchmarkScore): string {
  const catPts = (c: CategoryScore): string => {
    if (!c.measured) return `--/${c.max}`;
    const pts = `${Math.round(c.earned)}/${c.max}`;
    return Math.round(c.earned) >= c.max ? `${pts} ⭐` : pts;
  };
  const border = (l: string, r: string) => `${l}${'═'.repeat(WIDTH)}${r}`;
  return [
    border('╔', '╗'),
    `║${' Benchmark Score'.padEnd(WIDTH)}║`,
    border('╠', '╣'),
    ...(Object.keys(CATEGORY_LABELS) as CategoryKey[]).map((k) => boxRow(CATEGORY_LABELS[k], catPts(s[k]))),
    border('╠', '╣'),
    boxRow('Current Score', `${Math.round(s.overall.earned)}/${s.overall.available}`),
    border('╚', '╝'),
  ].join('\n');
}

// For each measured banded category, the metric that scored lowest — the one
// to look at first when a category loses points.
export function categoryWorstMetrics(metrics: BenchMetrics): Partial<Record<CategoryKey, string>> {
  const out: Partial<Record<CategoryKey, string>> = {};
  for (const key of Object.keys(BANDED_CATEGORIES) as Array<keyof typeof BANDED_CATEGORIES>) {
    const present = (BANDED_CATEGORIES[key].metrics as readonly (keyof typeof ANCHORS)[]).filter(
      (id) => metrics[id] !== undefined,
    );
    if (present.length === 0) continue;
    const worst = present.reduce((a, b) =>
      metricFrac(metrics[b]!, ANCHORS[b]) < metricFrac(metrics[a]!, ANCHORS[a]) ? b : a,
    );
    out[key] = `${worst} = ${metrics[worst]!.toFixed(2)}`;
  }
  return out;
}

export function toMarkdown(platform: string, out: RunOutput): string {
  const { results, score } = out;
  const lines = [
    `### ${platform} — ${new Date().toISOString()}`,
    '',
    '```',
    renderScorecard(score),
    '```',
    '',
    "Reliability's crash check is an in-process proxy (close/reopen), not a process kill.",
    '',
    '| benchmark | iterations | total ms | ms/op |',
    '|---|---:|---:|---:|',
    ...results.map((r) => `| ${r.name} | ${r.iterations} | ${r.totalMs.toFixed(1)} | ${r.perOpMs.toFixed(3)} |`),
    '',
    ...results.filter((r) => r.note).map((r) => `- **${r.name}**: ${r.note}`),
    '',
  ];
  return lines.join('\n');
}
