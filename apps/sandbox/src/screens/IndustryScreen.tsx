import { useState } from 'react';
import { Button, ScrollView, Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { runIndustry } from '../bench/industryRun';
import { renderIndustry, type IndustryResult } from '../bench/industryRefs';

export function IndustryScreen() {
  const [progress, setProgress] = useState<string[]>([]);
  const [results, setResults] = useState<IndustryResult[] | null>(null);
  const [running, setRunning] = useState(false);

  return (
    <ScrollView style={{ padding: 16 }}>
      <Button
        title={running ? 'Running…' : 'Run industry comparison'}
        disabled={running}
        onPress={async () => {
          setRunning(true);
          setProgress([]);
          setResults(null);
          try {
            setResults(await runIndustry((m) => setProgress((p) => [...p, m])));
          } catch (e) {
            setProgress((p) => [...p, `failed: ${e}`]);
          } finally {
            setRunning(false);
          }
        }}
      />
      {results && (
        <>
          <Button
            title="Copy as markdown"
            onPress={() => void Clipboard.setStringAsync('```\n' + renderIndustry(results) + '\n```')}
          />
          <Text style={{ fontFamily: 'monospace', fontSize: 12 }}>{renderIndustry(results)}</Text>
          <Text style={{ fontFamily: 'monospace', fontSize: 10, color: '#888', marginTop: 8 }}>
            Reference ranges are indicative figures for JSI/Rust stacks on modern hardware; rows with caveats
            compare different amounts of work.
          </Text>
        </>
      )}
      {!results &&
        progress.map((m, i) => (
          <Text key={i} style={{ fontFamily: 'monospace', fontSize: 12 }}>
            {m}
          </Text>
        ))}
      <View style={{ height: 32 }} />
    </ScrollView>
  );
}
