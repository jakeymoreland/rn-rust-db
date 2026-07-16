import React, { useCallback, useEffect, useState } from 'react';
import { FlatList, Text, View } from 'react-native';
import { redis, subscribe } from '@rn-experiments/reconcile-engine';

type Row = { key: string; fields: Record<string, string> };

export function EntriesScreen() {
  const [rows, setRows] = useState<Row[]>([]);

  const refresh = useCallback(async () => {
    const keys = await redis.scan('entry:people:*');
    const out: Row[] = [];
    for (const key of keys) {
      out.push({ key, fields: await redis.hgetall(key) });
    }
    setRows(out);
  }, []);

  useEffect(() => {
    void refresh();
    let unsub: (() => void) | undefined;
    void subscribe('changes:people', () => void refresh()).then((u) => (unsub = u));
    return () => unsub?.();
  }, [refresh]);

  return (
    <FlatList
      data={rows}
      keyExtractor={(r) => r.key}
      renderItem={({ item }) => (
        <View style={{ padding: 12, borderBottomWidth: 1 }}>
          <Text style={{ fontWeight: 'bold' }}>{item.key}</Text>
          {Object.entries(item.fields).map(([f, v]) => (
            <Text key={f}>{f}: {v}</Text>
          ))}
        </View>
      )}
    />
  );
}
