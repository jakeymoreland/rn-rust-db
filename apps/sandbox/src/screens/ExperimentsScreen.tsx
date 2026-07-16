import { useEffect, useState } from 'react';
import { Button, Platform, ScrollView, Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { executeRaw } from '@rn-experiments/reconcile-engine';
import { runAll, type RunOutput } from '../bench/phases';
import {
  CATEGORY_LABELS,
  categoryWorstMetrics,
  renderScorecard,
  toMarkdown,
  type CategoryKey,
} from '../bench/markdown';
import { BenchList } from '../bench/BenchList';
import { registerListVisibility } from '../bench/listBridge';
import { RealAppList, registerRealListVisibility } from '../bench/RealAppList';
import { renderRealApp, runRealApp, type RealAppResult } from '../bench/realAppRun';

if (__DEV__) {
  // Expose the harness so benchmarks can be driven over the Hermes inspector.
  (globalThis as Record<string, unknown>).__t16 = {
    runAll,
    toMarkdown,
    executeRaw,
  };
}

export function ExperimentsScreen() {
  const [progress, setProgress] = useState<string[]>([]);
  const [output, setOutput] = useState<RunOutput | null>(null);
  const [running, setRunning] = useState(false);
  const [listVisible, setListVisible] = useState(false);
  const [realListVisible, setRealListVisible] = useState(false);
  const [realApp, setRealApp] = useState<RealAppResult[] | null>(null);

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
      setOutput(await runAll((m) => setProgress((p) => [...p, m]), { includeHeavy }));
    } finally {
      setRunning(false);
    }
  };

  const runReal = async () => {
    setRunning(true);
    setProgress([]);
    setRealApp(null);
    try {
      setRealApp(await runRealApp((m) => setProgress((p) => [...p, m])));
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
      <Button
        title={running ? 'Running…' : 'Run benchmarks (quick)'}
        disabled={running}
        onPress={() => run(false)}
      />
      <Button
        title={running ? 'Running…' : 'Run full benchmarks (incl. 100k)'}
        disabled={running}
        onPress={() => run(true)}
      />
      <Button
        title={running ? 'Running…' : 'Run real-app list benchmark (LegendList)'}
        disabled={running}
        onPress={() => void runReal()}
      />
      {realApp && (
        <>
          <Text style={{ fontFamily: 'monospace', fontSize: 12, fontWeight: 'bold', marginTop: 8 }}>
            Real-app list (lazy zero-copy backing)
          </Text>
          <Text style={{ fontFamily: 'monospace', fontSize: 12 }}>{renderRealApp(realApp)}</Text>
          <Button
            title="Copy real-app results"
            onPress={() => void Clipboard.setStringAsync('```\n' + renderRealApp(realApp) + '\n```')}
          />
        </>
      )}
      {output && (
        <Button
          title="Copy as markdown"
          onPress={() => void Clipboard.setStringAsync(toMarkdown(Platform.OS, output))}
        />
      )}
      {output && (
        <>
          <Text style={{ fontFamily: 'monospace', fontSize: 12 }}>{renderScorecard(output.score)}</Text>
          {Object.entries(categoryWorstMetrics(output.metrics))
            .filter(([key]) => {
              const c = output.score[key as CategoryKey];
              return c.measured && Math.round(c.earned) < c.max;
            })
            .map(([key, detail]) => (
              <Text key={key} style={{ fontFamily: 'monospace', fontSize: 11, color: '#a55' }}>
                {CATEGORY_LABELS[key as CategoryKey]} lost most on: {detail}
              </Text>
            ))}
        </>
      )}
      {progress.map((m, i) => (
        <Text key={i} style={{ fontFamily: 'monospace', fontSize: 12 }}>
          {m}
        </Text>
      ))}
      <View style={{ height: 32 }} />
    </ScrollView>
  );
}
