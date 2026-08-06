import { useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { StatusBar } from 'expo-status-bar';
import { renderResults, runContender, type ContenderResult } from './src/run';
import { sqliteRaw } from './src/contenders/sqliteRaw';
import { reconcileEngine } from './src/contenders/reconcileEngine';
import type { Contender } from './src/contender';

// The floor goes first, so every other number reads as "what this library costs
// above raw SQLite on this device".
const CONTENDERS: Contender[] = [sqliteRaw, reconcileEngine];

const MUTED = '#6b6b70';
const HAIR = StyleSheet.hairlineWidth;

function fmt(ms: number): string {
  return ms < 1 ? `${ms.toFixed(4)} ms` : `${ms.toFixed(2)} ms`;
}

export default function App() {
  const [results, setResults] = useState<ContenderResult[] | null>(null);
  const [progress, setProgress] = useState<string[]>([]);
  const [running, setRunning] = useState(false);

  const run = async () => {
    setRunning(true);
    setProgress([]);
    setResults(null);
    const out: ContenderResult[] = [];
    try {
      for (const c of CONTENDERS) {
        out.push(await runContender(c, (m) => setProgress((p) => [...p, m])));
        setResults([...out]);
      }
      if (__DEV__) console.log(`shootout (${Platform.OS})\n${renderResults(out)}`);
    } finally {
      setRunning(false);
    }
  };

  const scenarios = Array.from(
    new Set((results ?? []).flatMap((r) => r.timings.map((t) => t.scenario))),
  );

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: '#fff' }}
      contentContainerStyle={{ padding: 20, paddingTop: 64, paddingBottom: 90 }}
    >
      <Text style={{ fontSize: 22, fontWeight: '700' }}>RN database shootout</Text>
      <Text style={{ fontSize: 13, color: MUTED, marginTop: 6, lineHeight: 19 }}>
        Same device, same rows, same durability setting, same harness. The reconcile engine is one
        contender among several and gets no special treatment.
      </Text>

      <Pressable
        onPress={() => void run()}
        disabled={running}
        style={({ pressed }) => ({
          marginTop: 20,
          paddingVertical: 14,
          borderTopWidth: HAIR,
          borderBottomWidth: HAIR,
          borderColor: '#e3e3e6',
          backgroundColor: pressed ? '#f2f2f4' : 'transparent',
          flexDirection: 'row',
          justifyContent: 'space-between',
        })}
      >
        <Text style={{ fontSize: 15, color: running ? '#9a9aa0' : '#111' }}>
          {running ? 'Running…' : 'Run shootout'}
        </Text>
        <Text style={{ fontSize: 13, color: '#9a9aa0' }}>{running ? '' : '›'}</Text>
      </Pressable>

      {results && results.length > 0 && (
        <View style={{ marginTop: 24 }}>
          {scenarios.map((s) => (
            <View
              key={s}
              style={{ paddingVertical: 10, borderBottomWidth: HAIR, borderBottomColor: '#e3e3e6' }}
            >
              <Text style={{ fontSize: 13, color: '#111', marginBottom: 5 }}>{s}</Text>
              {results.map((r) => {
                const t = r.timings.find((x) => x.scenario === s);
                const val = !t
                  ? '—'
                  : Number.isNaN(t.msPerOp)
                    ? (t.note ?? 'n/a')
                    : fmt(t.msPerOp);
                return (
                  <View
                    key={r.name}
                    style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 2 }}
                  >
                    <Text style={{ fontSize: 12, color: MUTED, flexShrink: 1 }}>{r.name}</Text>
                    <Text style={{ fontFamily: 'monospace', fontSize: 12, color: '#111' }}>{val}</Text>
                  </View>
                );
              })}
            </View>
          ))}

          <View style={{ marginTop: 18 }}>
            {results.map((r) => (
              <View key={r.name} style={{ marginBottom: 12 }}>
                <Text style={{ fontSize: 12, fontWeight: '600' }}>{r.name}</Text>
                <Text style={{ fontSize: 11, color: MUTED, marginTop: 2 }}>
                  {r.configuration} · survives: {r.durability}
                </Text>
                {r.caveats.map((c) => (
                  <Text key={c} style={{ fontSize: 11, color: MUTED, marginTop: 2 }}>
                    • {c}
                  </Text>
                ))}
                {r.error && (
                  <Text style={{ fontSize: 11, color: '#c8332b', marginTop: 2 }}>FAILED: {r.error}</Text>
                )}
              </View>
            ))}
          </View>

          <Pressable
            onPress={() => void Clipboard.setStringAsync(renderResults(results))}
            style={({ pressed }) => ({ marginTop: 6, opacity: pressed ? 0.5 : 1 })}
          >
            <Text style={{ fontSize: 12, color: '#0b6bcb' }}>Copy as markdown</Text>
          </Pressable>
        </View>
      )}

      {progress.length > 0 && (
        <View style={{ marginTop: 22 }}>
          {progress.slice(-14).map((m, i) => (
            <Text
              key={i}
              style={{ fontFamily: 'monospace', fontSize: 10, color: MUTED, lineHeight: 15 }}
            >
              {m}
            </Text>
          ))}
        </View>
      )}
      <StatusBar style="auto" />
    </ScrollView>
  );
}
