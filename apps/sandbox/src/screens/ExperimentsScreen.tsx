import { useState } from 'react';
import { Button, Platform, ScrollView, Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { executeRaw } from '@rn-experiments/reconcile-engine';
import { runAll, type RunOutput } from '../bench/phases';
import { CATEGORY_LABELS, categoryWorstMetrics, renderScorecard, toMarkdown, type CategoryKey } from '../bench/markdown';
import { BenchList } from '../bench/BenchList';

if (__DEV__) {
  // Expose the harness so benchmarks can be driven over the Hermes inspector.
  (globalThis as Record<string, unknown>).__t16 = { runAll, toMarkdown, executeRaw };
}

export function ExperimentsScreen() {
  const [progress, setProgress] = useState<string[]>([]);
  const [output, setOutput] = useState<RunOutput | null>(null);
  const [running, setRunning] = useState(false);

  return (
    <ScrollView style={{ padding: 16 }}>
      <Button
        title={running ? 'Running…' : 'Run benchmarks'}
        disabled={running}
        onPress={async () => {
          setRunning(true);
          setProgress([]);
          setOutput(null);
          try {
            setOutput(await runAll((m) => setProgress((p) => [...p, m])));
          } finally {
            setRunning(false);
          }
        }}
      />
      {output && (
        <Button
          title="Copy as markdown"
          onPress={() => void Clipboard.setStringAsync(toMarkdown(Platform.OS, output))}
        />
      )}
      {running && <BenchList />}
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
