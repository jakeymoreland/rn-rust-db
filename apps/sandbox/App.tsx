import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { Button, StyleSheet, Text, View } from 'react-native';
import { Paths } from 'expo-file-system';
import { installFastPath, openEngine, registerSource } from '@rn-experiments/reconcile-engine';
import { SOURCES } from './src/fixtures';
import { SourcesScreen } from './src/screens/SourcesScreen';
import { EntriesScreen } from './src/screens/EntriesScreen';

type Tab = 'sources' | 'entries' | 'experiments';

export default function App() {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('sources');

  useEffect(() => {
    (async () => {
      try {
        const dir = Paths.document.uri.replace(/^file:\/\//, '');
        await openEngine(`${dir}/engine.sqlite`);
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
        {tab === 'experiments' && (
          <View style={styles.container}>
            <Text>Experiments (coming in Task 16)</Text>
          </View>
        )}
      </View>
      <View style={styles.tabBar}>
        <Button title="Sources" onPress={() => setTab('sources')} />
        <Button title="Entries" onPress={() => setTab('entries')} />
        <Button title="Experiments" onPress={() => setTab('experiments')} />
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
    paddingVertical: 8,
    borderTopWidth: 1,
    borderTopColor: '#ccc',
  },
});
