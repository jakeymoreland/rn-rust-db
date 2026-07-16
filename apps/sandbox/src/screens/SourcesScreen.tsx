import React, { useState } from 'react';
import { Button, ScrollView, Text, View } from 'react-native';
import { File, Paths } from 'expo-file-system';
import { ingest, ingestFile, type BatchSummary } from '@rn-experiments/reconcile-engine';
import { API_PAYLOAD, CSV_PAYLOAD, devicePayload } from '../fixtures';

export function SourcesScreen() {
  const [log, setLog] = useState<string[]>([]);
  const report = (label: string, s: BatchSummary) =>
    setLog((l) => [
      `${label}: +${s.inserted} ~${s.updated} =${s.unchanged} !${s.dead_lettered}${s.skipped ? ' (skipped)' : ''}`,
      ...l,
    ]);

  return (
    <ScrollView style={{ padding: 16 }}>
      <Button title="Ingest API JSON" onPress={async () => report('api', await ingest('api', API_PAYLOAD))} />
      <View style={{ height: 8 }} />
      <Button
        title="Import CSV (via file)"
        onPress={async () => {
          const f = new File(Paths.cache, 'import.csv');
          f.write(CSV_PAYLOAD);
          report('csv', await ingestFile('csv', f.uri.replace('file://', '')));
        }}
      />
      <View style={{ height: 8 }} />
      <Button title="Device ping" onPress={async () => report('device', await ingest('device', devicePayload()))} />
      <View style={{ marginTop: 16 }}>
        {log.map((l, i) => (
          <Text key={i}>{l}</Text>
        ))}
      </View>
    </ScrollView>
  );
}
