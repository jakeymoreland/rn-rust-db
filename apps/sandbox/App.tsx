import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { Button, StyleSheet, Text, View } from 'react-native';
import { Paths } from 'expo-file-system';
import { installFastPath, openEngine, registerSource } from '@rn-experiments/reconcile-engine';
import { SOURCES } from './src/fixtures';
import { setEnginePath } from './src/enginePath';
import { SourcesScreen } from './src/screens/SourcesScreen';
import { EntriesScreen } from './src/screens/EntriesScreen';
import { ExperimentsScreen } from './src/screens/ExperimentsScreen';
import { IndustryScreen } from './src/screens/IndustryScreen';

type Tab = 'sources' | 'entries' | 'experiments' | 'industry';

export default function App() {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('sources');

  useEffect(() => {
    (async () => {
      try {
        const dir = Paths.document.uri.replace(/^file:\/\//, '');
        setEnginePath(`${dir}/engine.sqlite`);
        const t0 = performance.now();
        await openEngine(`${dir}/engine.sqlite`);
        const coldStartMs = performance.now() - t0;
        console.log(`[bench] openEngine cold start: ${coldStartMs.toFixed(1)} ms`);
        if (__DEV__) (globalThis as Record<string, unknown>).__coldStartMs = coldStartMs;
        for (const source of SOURCES) {
          await registerSource(source);
        }
        installFastPath();
        setReady(true);
      } catch (e) {
        console.error('[sandbox] init failed', e);
        setError(String(e));
      }
    })();
  }, []);

  if (error) {
    return (
      <View style={styles.container}>
        <Text>Init failed: {error}</Text>
        <StatusBar style="auto" />
      </View>
    );
  }

  if (!ready) {
    return (
      <View style={styles.container}>
        <Text>Starting engine…</Text>
        <StatusBar style="auto" />
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <View style={styles.content}>
        {tab === 'sources' && <SourcesScreen />}
        {tab === 'entries' && <EntriesScreen />}
        {tab === 'experiments' && <ExperimentsScreen />}
        {tab === 'industry' && <IndustryScreen />}
      </View>
      <View style={styles.tabBar}>
        <Button title="Sources" onPress={() => setTab('sources')} />
        <Button title="Entries" onPress={() => setTab('entries')} />
        <Button title="Experiments" onPress={() => setTab('experiments')} />
        <Button title="Industry" onPress={() => setTab('industry')} />
      </View>
      <StatusBar style="auto" />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#fff',
    paddingTop: 50,
  },
  content: {
    flex: 1,
  },
  container: {
    flex: 1,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  tabBar: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    paddingTop: 8,
    // Android builds run edge-to-edge (gradle.properties edgeToEdgeEnabled=true),
    // so this bar draws *behind* the system nav bar and its buttons swallow the
    // taps. A blunt 80 clears both the 3-button bar (48dp) and the gesture pill
    // (~24dp) on every device we test on. The correct fix is
    // react-native-safe-area-context's useSafeAreaInsets, but that is a native
    // module — this is a benchmark sandbox, not shipping UI, and a constant
    // keeps it to a Fast Refresh instead of a rebuild-and-reinstall.
    paddingBottom: 80,
    borderTopWidth: 1,
    borderTopColor: '#ccc',
  },
});
