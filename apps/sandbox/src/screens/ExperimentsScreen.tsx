import { useState } from 'react';
import { Button, Platform, ScrollView, Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { executeRaw } from '@rn-experiments/reconcile-engine';
import { runAll, type RunOutput } from '../bench/phases';
import { renderScorecard, toMarkdown } from '../bench/markdown';

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
      {output && (
        <Text style={{ fontFamily: 'monospace', fontSize: 12 }}>{renderScorecard(output.score)}</Text>
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
