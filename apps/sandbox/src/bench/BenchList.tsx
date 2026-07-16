import { useEffect, useRef, useState } from 'react';
import { FlatList, Text, View } from 'react-native';
import type { Row } from './decode';
import { registerListDriver } from './listBridge';

const LIST_HEIGHT = 300;
const SCROLL_STEP_PX = 16;
const SCROLL_STEP_MS = 32;

export function BenchList() {
  const [rows, setRows] = useState<Row[]>([]);
  const [version, setVersion] = useState(0);
  const listRef = useRef<FlatList<Row>>(null);
  const commitResolvers = useRef<Array<() => void>>([]);
  const contentHeight = useRef(0);
  const offset = useRef(0);
  const scrollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  // Resolves every pending setRows() promise after the commit that carried it.
  useEffect(() => {
    const resolvers = commitResolvers.current;
    commitResolvers.current = [];
    for (const r of resolvers) r();
  }, [version]);

  useEffect(() => {
    registerListDriver({
      setRows: (next: Row[]) =>
        new Promise<void>((resolve) => {
          commitResolvers.current.push(resolve);
          setRows(next);
          setVersion((v) => v + 1);
        }),
      startScroll: () => {
        if (scrollTimer.current) return;
        scrollTimer.current = setInterval(() => {
          offset.current += SCROLL_STEP_PX;
          if (offset.current > Math.max(0, contentHeight.current - LIST_HEIGHT)) offset.current = 0;
          listRef.current?.scrollToOffset({ offset: offset.current, animated: false });
        }, SCROLL_STEP_MS);
      },
      stopScroll: () => {
        if (scrollTimer.current) clearInterval(scrollTimer.current);
        scrollTimer.current = null;
      },
    });
    return () => {
      if (scrollTimer.current) clearInterval(scrollTimer.current);
      registerListDriver(null);
    };
  }, []);

  return (
    <View style={{ height: LIST_HEIGHT, borderWidth: 1, borderColor: '#ccc' }}>
      <FlatList
        ref={listRef}
        data={rows}
        keyExtractor={(r) => r.key}
        onContentSizeChange={(_, h) => (contentHeight.current = h)}
        renderItem={({ item }) => (
          <View style={{ paddingVertical: 6, paddingHorizontal: 10, borderBottomWidth: 1, borderBottomColor: '#eee' }}>
            <Text style={{ fontWeight: 'bold', fontSize: 12 }}>
              {item.fields.first_name} {item.fields.last_name} — {item.fields.company}
            </Text>
            <Text style={{ fontSize: 11 }}>
              ${item.fields.balance} · {item.fields.status} · {item.fields.updated_at}
            </Text>
          </View>
        )}
      />
    </View>
  );
}
