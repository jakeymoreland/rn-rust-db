import { useState } from 'react';
import { Platform, Pressable, ScrollView, Text, View, StyleSheet } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { runIndustry } from '../bench/industryRun';
import { renderIndustry, verdict, type IndustryResult } from '../bench/industryRefs';
import { renderDurability, runDurability, type DurabilityResult } from '../bench/durabilityRun';
import { renderHotPath, runHotPath, type HotPathResult } from '../bench/hotPathRun';
import { renderPhase2, runPhase2, type Phase2Result } from '../bench/phase2Run';

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

export function IndustryScreen() {
  const [progress, setProgress] = useState<string[]>([]);
  const [results, setResults] = useState<IndustryResult[] | null>(null);
  const [durability, setDurability] = useState<DurabilityResult[] | null>(null);
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
      // Also to Metro — otherwise a failure is visible only on the device,
      // which is how the first durability run vanished without a trace.
      if (__DEV__) console.log(`industry screen run failed: ${e}`);
    } finally {
      setRunning(false);
    }
  };

  return (
    <ScrollView style={{ padding: 16 }}>
      <ActionButton
        label="Industry comparison"
        busy={running}
        onPress={() =>
          run(async () => {
            setResults(null);
            const r = await runIndustry((m) => setProgress((p) => [...p, m]));
            setResults(r);
            if (__DEV__) console.log(`industry (${Platform.OS})\n${renderIndustry(r)}`);
          })
        }
      />
      <ActionButton
        label="Hot-path benchmarks (kv)"
        busy={running}
        onPress={() =>
          run(async () => {
            setHotPath(null);
            const r = await runHotPath((m) => setProgress((p) => [...p, m]));
            setHotPath(r);
            if (__DEV__) console.log(`hot path (${Platform.OS})\n${renderHotPath(r)}`);
          })
        }
      />
      <ActionButton
        label="Bulk & flush (phase 2)"
        busy={running}
        onPress={() =>
          run(async () => {
            setPhase2(null);
            const r = await runPhase2((m) => setProgress((p) => [...p, m]));
            setPhase2(r);
            if (__DEV__) console.log(`phase 2 (${Platform.OS})\n${renderPhase2(r)}`);
          })
        }
      />
      <ActionButton
        label="Durability comparison (fsync cost)"
        busy={running}
        onPress={() =>
          run(async () => {
            setDurability(null);
            const r = await runDurability((m2) => setProgress((p) => [...p, m2]));
            setDurability(r);
            // Also to the Metro log: "copy as markdown" needs the device in
            // hand, and these numbers are the ones that get quoted publicly.
            if (__DEV__) console.log(`durability (${Platform.OS})\n${renderDurability(r)}`);
          })
        }
      />
      {(results || hotPath || phase2) && (
        <CopyButton
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
      {durability && (
        <View style={{ marginTop: 12 }}>
          <Text style={{ fontSize: 12, fontWeight: '600', color: '#6b6b70', letterSpacing: 0.6, marginBottom: 4 }}>
            DURABILITY · COST OF A SINGLE INSERT
          </Text>
          {durability.map((r) => (
            <View
              key={r.mode}
              style={{
                paddingVertical: 9,
                borderBottomWidth: StyleSheet.hairlineWidth,
                borderBottomColor: '#e3e3e6',
              }}
            >
              <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                <Text style={{ fontSize: 14, color: '#111', flexShrink: 1 }}>{r.mode}</Text>
                <Text style={{ fontFamily: 'monospace', fontSize: 13, fontWeight: '600' }}>
                  {r.msPerInsert.toFixed(4)} ms
                </Text>
              </View>
              <Text style={{ fontFamily: 'monospace', fontSize: 11, color: '#6b6b70', marginTop: 2 }}>
                {r.tax} vs default · survives: {r.survives}
              </Text>
            </View>
          ))}
          <CopyButton
            onPress={() =>
              void Clipboard.setStringAsync('```\n' + renderDurability(durability) + '\n```')
            }
          />
        </View>
      )}
      {results && (
        <View style={{ marginTop: 8 }}>
          {results.map(({ ref, oursMs }) => {
            const v = verdict(oursMs, ref);
            const tint = v === 'unscored' ? '#6b6b70' : v === 'slower' ? '#c8332b' : '#1a7f37';
            const fmt = (ms: number) => (ms < 0.1 ? ms.toFixed(4) : ms < 10 ? ms.toFixed(2) : ms.toFixed(1));
            const refStr =
              ref.refLoMs === ref.refHiMs ? `~${fmt(ref.refLoMs)}` : `${fmt(ref.refLoMs)}–${fmt(ref.refHiMs)}`;
            return (
              <View
                key={ref.key}
                style={{
                  paddingVertical: 9,
                  borderBottomWidth: StyleSheet.hairlineWidth,
                  borderBottomColor: '#e3e3e6',
                }}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                  <Text style={{ color: tint, fontSize: 13, width: 16 }}>
                    {v === 'unscored' ? '·' : v === 'slower' ? '✗' : '✓'}
                  </Text>
                  <Text style={{ fontSize: 14, color: '#111', flexShrink: 1 }}>
                    {ref.component}: {ref.operation}
                  </Text>
                </View>
                <View style={{ flexDirection: 'row', marginLeft: 16, marginTop: 3 }}>
                  <Text style={{ fontFamily: 'monospace', fontSize: 11, color: tint, fontWeight: '600' }}>
                    {fmt(oursMs)} {ref.unit}
                  </Text>
                  <Text style={{ fontFamily: 'monospace', fontSize: 11, color: '#6b6b70' }}>
                    {v === 'unscored' ? '  (no comparable reference)' : `  vs industry ${refStr}`}
                  </Text>
                </View>
                {ref.caveat && (
                  <Text style={{ fontSize: 10, color: '#6b6b70', marginLeft: 16, marginTop: 2, fontStyle: 'italic' }}>
                    {ref.caveat}
                  </Text>
                )}
              </View>
            );
          })}
          <Text style={{ fontSize: 10, color: '#8a8a8e', marginTop: 10 }}>
            Reference ranges are indicative figures for JSI/Rust stacks on modern hardware (iPhone 14+/SD 8 Gen 2+);
            rows with caveats compare different amounts of work.
          </Text>
        </View>
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
