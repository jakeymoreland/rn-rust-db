import { useState } from 'react';
import { Button, ScrollView, Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { runIndustry } from '../bench/industryRun';
import { renderIndustry, type IndustryResult } from '../bench/industryRefs';
import { renderHotPath, runHotPath, type HotPathResult } from '../bench/hotPathRun';
import { renderPhase2, runPhase2, type Phase2Result } from '../bench/phase2Run';

export function IndustryScreen() {
  const [progress, setProgress] = useState<string[]>([]);
  const [results, setResults] = useState<IndustryResult[] | null>(null);
  const [hotPath, setHotPath] = useState<HotPathResult[] | null>(null);
  const [phase2, setPhase2] = useState<Phase2Result[] | null>(null);
  const [running, setRunning] = useState(false);

  const run = async (fn: () => Promise<void>) => {
    setRunning(true);
    setProgress([]);
    try {
      await fn();
    } catch (e) {
      setProgress((p) => [...p, `failed: ${e}`]);
    } finally {
      setRunning(false);
    }
  };

  return (
    <ScrollView style={{ padding: 16 }}>
      <Button
        title={running ? 'Running…' : 'Run industry comparison'}
        disabled={running}
        onPress={() =>
          run(async () => {
            setResults(null);
            setResults(await runIndustry((m) => setProgress((p) => [...p, m])));
          })
        }
      />
      <Button
        title={running ? 'Running…' : 'Run hot-path benchmarks (kv)'}
        disabled={running}
        onPress={() =>
          run(async () => {
            setHotPath(null);
            setHotPath(await runHotPath((m) => setProgress((p) => [...p, m])));
          })
        }
      />
      <Button
        title={running ? 'Running…' : 'Run bulk & flush benchmarks (phase 2)'}
        disabled={running}
        onPress={() =>
          run(async () => {
            setPhase2(null);
            setPhase2(await runPhase2((m) => setProgress((p) => [...p, m])));
          })
        }
      />
      {(results || hotPath || phase2) && (
        <Button
          title="Copy as markdown"
          onPress={() => {
            const parts = [];
            if (results) parts.push(renderIndustry(results));
            if (hotPath) parts.push(renderHotPath(hotPath));
            if (phase2) parts.push(renderPhase2(phase2));
            void Clipboard.setStringAsync('```\n' + parts.join('\n\n') + '\n```');
          }}
        />
      )}
      {phase2 && (
        <>
          <Text style={{ fontFamily: 'monospace', fontSize: 12, fontWeight: 'bold', marginTop: 8 }}>
            Bulk & flush (phase 2)
          </Text>
          <Text style={{ fontFamily: 'monospace', fontSize: 12 }}>{renderPhase2(phase2)}</Text>
        </>
      )}
      {hotPath && (
        <>
          <Text style={{ fontFamily: 'monospace', fontSize: 12, fontWeight: 'bold', marginTop: 8 }}>
            Hot path (kv write-behind)
          </Text>
          <Text style={{ fontFamily: 'monospace', fontSize: 12 }}>{renderHotPath(hotPath)}</Text>
        </>
      )}
      {results && (
        <>
          <Text style={{ fontFamily: 'monospace', fontSize: 12, marginTop: 8 }}>{renderIndustry(results)}</Text>
          <Text style={{ fontFamily: 'monospace', fontSize: 10, color: '#888', marginTop: 8 }}>
            Reference ranges are indicative figures for JSI/Rust stacks on modern hardware; rows with caveats
            compare different amounts of work.
          </Text>
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
