import { useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { LegendList, type LegendListRef } from '@legendapp/list/react-native';
import type { Row } from './decode';
import { registerListDriver } from './listBridge';

const SCROLL_STEP_PX = 16;
const SCROLL_STEP_MS = 32;
const ESTIMATED_ITEM_SIZE = 48;

export function BenchList() {
  const [rows, setRows] = useState<Row[]>([]);
  const [version, setVersion] = useState(0);
  const listRef = useRef<LegendListRef>(null);
  const commitResolvers = useRef<Array<() => void>>([]);
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
          const list = listRef.current;
          if (!list) return;
          const state = list.getState();
          const maxOffset = Math.max(0, (state?.contentLength ?? 0) - (state?.scrollLength ?? 0));
          offset.current = offset.current + SCROLL_STEP_PX > maxOffset ? 0 : offset.current + SCROLL_STEP_PX;
          list.scrollToOffset({ offset: offset.current, animated: false });
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
    <View style={{ flex: 1 }}>
      <Text
        style={{
          fontFamily: 'monospace',
          fontSize: 12,
          padding: 8,
          backgroundColor: '#eee',
        }}
      >
        benchmark list — running…
      </Text>
      <LegendList
        ref={listRef}
        data={rows}
        keyExtractor={(r: Row) => r.key}
        estimatedItemSize={ESTIMATED_ITEM_SIZE}
        recycleItems
        renderItem={({ item }: { item: Row }) => (
          <View
            style={{
              paddingVertical: 6,
              paddingHorizontal: 10,
              borderBottomWidth: 1,
              borderBottomColor: '#eee',
            }}
          >
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
