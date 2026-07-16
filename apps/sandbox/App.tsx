import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Paths } from 'expo-file-system';
import { openEngine, redis } from '@rn-experiments/reconcile-engine';

export default function App() {
  const [result, setResult] = useState<string>('running…');

  useEffect(() => {
    (async () => {
      try {
        const dir = Paths.document.uri.replace(/^file:\/\//, '');
        await openEngine(`${dir}/engine.sqlite`);
        await redis.set('hello', 'world');
        const value = await redis.get('hello');
        console.log('[smoke] redis.get(hello) =>', value);
        setResult(`redis.get('hello') = ${value}`);
      } catch (e) {
        console.error('[smoke] failed', e);
        setResult(`smoke test failed: ${String(e)}`);
      }
    })();
  }, []);

  return (
    <View style={styles.container}>
      <Text>{result}</Text>
      <StatusBar style="auto" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
