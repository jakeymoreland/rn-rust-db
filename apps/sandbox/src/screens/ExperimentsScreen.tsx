import { useEffect, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { executeRaw } from '@rn-experiments/reconcile-engine';
import { runAll, type RunOutput } from '../bench/phases';
import {
  CATEGORY_LABELS,
  categoryWorstMetrics,
  toMarkdown,
  type CategoryKey,
} from '../bench/markdown';
import { BenchList } from '../bench/BenchList';
import { registerListVisibility } from '../bench/listBridge';
import { RealAppList, registerRealListVisibility } from '../bench/RealAppList';
import { renderRealApp, runRealApp, type RealAppResult } from '../bench/realAppRun';
import { renderFeeds, runFeeds, type FeedResult } from '../bench/feedsRun';

if (__DEV__) {
  // Expose the harness so benchmarks can be driven over the Hermes inspector.
  (globalThis as Record<string, unknown>).__t16 = {
    runAll,
    toMarkdown,
    executeRaw,
  };
}

/** Chunky pill button. `tone` picks the accent; `busy` dims and disables. */
function ActionButton({
  label,
  onPress,
  busy,
}: {
  label: string;
  onPress: () => void;
  busy?: boolean;
  emoji?: string;
  tone?: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={busy}
      style={({ pressed }) => ({
        backgroundColor: pressed ? '#f2f2f4' : 'transparent',
        paddingVertical: 14,
        paddingHorizontal: 2,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: '#e3e3e6',
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
      })}
    >
      <Text style={{ fontSize: 15, color: busy ? '#9a9aa0' : '#111' }}>{label}</Text>
      <Text style={{ fontSize: 13, color: '#9a9aa0' }}>{busy ? 'running' : '\u203A'}</Text>
    </Pressable>
  );
}

function CopyButton({ onPress, label = 'Copy as markdown' }: { onPress: () => void; label?: string }) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({ alignSelf: 'flex-start', marginTop: 12, opacity: pressed ? 0.5 : 1 })}
    >
      <Text style={{ fontSize: 12, color: '#0b6bcb' }}>{label}</Text>
    </Pressable>
  );
}

const OK = '#1a7f37';
const BAD = '#c8332b';
const MUTED = '#6b6b70';

/** One result line: status glyph, name, and a muted monospace detail under it. */
function ResultRow({ pass, name, detail }: { pass?: boolean; name: string; detail: string }) {
  const tint = pass === undefined ? MUTED : pass ? OK : BAD;
  return (
    <View style={{ paddingVertical: 9, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#e3e3e6' }}>
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <Text style={{ color: tint, fontSize: 13, width: 16 }}>
          {pass === undefined ? '·' : pass ? '✓' : '✗'}
        </Text>
        <Text style={{ fontSize: 14, color: '#111', flexShrink: 1 }}>{name}</Text>
      </View>
      <Text style={{ fontFamily: 'monospace', fontSize: 11, color: MUTED, marginTop: 3, marginLeft: 16 }}>
        {detail}
      </Text>
    </View>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <Text style={{ fontSize: 12, fontWeight: '600', color: MUTED, letterSpacing: 0.6, marginTop: 22, marginBottom: 4 }}>
      {String(children).toUpperCase()}
    </Text>
  );
}

export function ExperimentsScreen() {
  const [progress, setProgress] = useState<string[]>([]);
  const [output, setOutput] = useState<RunOutput | null>(null);
  const [running, setRunning] = useState(false);
  const [listVisible, setListVisible] = useState(false);
  const [realListVisible, setRealListVisible] = useState(false);
  const [realApp, setRealApp] = useState<RealAppResult[] | null>(null);
  const [feeds, setFeeds] = useState<FeedResult[] | null>(null);

  useEffect(() => {
    registerListVisibility(setListVisible);
    registerRealListVisibility(setRealListVisible);
    return () => {
      registerListVisibility(null);
      registerRealListVisibility(null);
    };
  }, []);

  const run = async (includeHeavy: boolean) => {
    setRunning(true);
    setProgress([]);
    setOutput(null);
    try {
      const out = await runAll((m) => setProgress((p) => [...p, m]), { includeHeavy });
      setOutput(out);
      // Also emit the markdown to the Metro log. "Copy as markdown" needs a
      // human with the device in hand; this is the same text, capturable from
      // a terminal — which is what BENCHMARKS.md's paste-per-platform workflow
      // actually needs, especially on an emulator or a tethered device.
      if (__DEV__) console.log(toMarkdown(Platform.OS, out));
    } finally {
      setRunning(false);
    }
  };

  const runReal = async () => {
    setRunning(true);
    setProgress([]);
    setRealApp(null);
    try {
      const result = await runRealApp((m) => setProgress((p) => [...p, m]));
      setRealApp(result);
      if (__DEV__) console.log(`real-app list (${Platform.OS})\n${renderRealApp(result)}`);
    } catch (e) {
      setProgress((p) => [...p, `failed: ${e}`]);
    } finally {
      setRunning(false);
    }
  };

  const runFeedScenarios = async () => {
    setRunning(true);
    setProgress([]);
    setFeeds(null);
    try {
      const result = await runFeeds((m) => setProgress((p) => [...p, m]));
      setFeeds(result);
      if (__DEV__) console.log(`betting feeds (${Platform.OS})\n${renderFeeds(result)}`);
    } catch (e) {
      setProgress((p) => [...p, `failed: ${e}`]);
    } finally {
      setRunning(false);
    }
  };

  // The list phases swap the whole screen to a list route: a virtualized
  // list must not be nested inside this ScrollView.
  if (listVisible) {
    return <BenchList />;
  }
  if (realListVisible) {
    return <RealAppList />;
  }

  return (
    <ScrollView style={{ padding: 16 }}>
      <ActionButton label="Run benchmarks (quick)" busy={running} onPress={() => run(false)} />
      <ActionButton label="Full benchmarks (incl. 100k)" busy={running} onPress={() => run(true)} />
      <ActionButton label="Real-app list (LegendList)" busy={running} onPress={() => void runReal()} />
      <ActionButton label="Betting-feed scenarios" busy={running} onPress={() => void runFeedScenarios()} />
      {feeds && (
        <View>
          <SectionTitle>Betting feeds · multi-source price book</SectionTitle>
          {feeds.map((r) => (
            <ResultRow key={r.name} pass={r.pass} name={r.name} detail={r.detail} />
          ))}
          <CopyButton
            onPress={() =>
              void Clipboard.setStringAsync(
                `### betting feeds (${Platform.OS}) — ${new Date().toISOString()}\n\n\`\`\`\n${renderFeeds(feeds)}\n\`\`\`\n`,
              )
            }
          />
        </View>
      )}
      {realApp && (
        <View>
          <SectionTitle>Real-app list · lazy zero-copy backing</SectionTitle>
          {realApp.map((r) => (
            <ResultRow key={r.name} name={r.name} detail={r.value} />
          ))}
          <CopyButton onPress={() => void Clipboard.setStringAsync('```\n' + renderRealApp(realApp) + '\n```')} />
        </View>
      )}
      {output && (
        <View>
          <SectionTitle>Benchmark score</SectionTitle>
          {(Object.keys(CATEGORY_LABELS) as CategoryKey[]).map((k) => {
            const c = output.score[k];
            const ratio = c.measured ? c.earned / c.max : -1;
            const tint = !c.measured ? MUTED : ratio >= 0.999 ? OK : ratio >= 0.6 ? '#111' : BAD;
            const worst = categoryWorstMetrics(output.metrics)[k];
            return (
              <View
                key={k}
                style={{ paddingVertical: 7, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#e3e3e6' }}
              >
                <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                  <Text style={{ fontSize: 14, color: '#111' }}>{CATEGORY_LABELS[k]}</Text>
                  <Text style={{ fontSize: 14, fontVariant: ['tabular-nums'], color: tint, fontWeight: '600' }}>
                    {c.measured ? `${Math.round(c.earned)}/${c.max}` : `--/${c.max}`}
                  </Text>
                </View>
                {c.measured && Math.round(c.earned) < c.max && worst && (
                  <Text style={{ fontFamily: 'monospace', fontSize: 10, color: BAD, marginTop: 2 }}>
                    worst: {worst}
                  </Text>
                )}
              </View>
            );
          })}
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingTop: 10 }}>
            <Text style={{ fontSize: 15, fontWeight: '700' }}>Total</Text>
            <Text style={{ fontSize: 15, fontWeight: '700', fontVariant: ['tabular-nums'] }}>
              {Math.round(output.score.overall.earned)}/{output.score.overall.available}
            </Text>
          </View>
          <CopyButton onPress={() => void Clipboard.setStringAsync(toMarkdown(Platform.OS, output))} />
        </View>
      )}
      {progress.length > 0 && <SectionTitle>Log</SectionTitle>}
      {progress.map((m, i) => (
        <Text key={i} style={{ fontFamily: 'monospace', fontSize: 10, color: MUTED, lineHeight: 15 }}>
          {m}
        </Text>
      ))}
      <View style={{ height: 32 }} />
    </ScrollView>
  );
}
