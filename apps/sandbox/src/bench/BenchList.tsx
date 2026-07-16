import { memo, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { LegendList, type LegendListRef } from '@legendapp/list/react-native';
import type { Row } from './decode';
import { registerListDriver } from './listBridge';

// Constant scroll velocity, applied per animation frame (time-scaled so the
// speed is the same at 60 and 120 Hz). rAF keeps scroll commands aligned with
// the frame boundary instead of firing from a timer mid-render, which
// provoked Legend List's internal setState-during-render warning.
const SCROLL_PX_PER_MS = 0.5; // 500 px/s
// Rows are a fixed 44 px so Legend List's size estimate is exact — no
// post-layout correction work while scrolling.
const ROW_HEIGHT = 44;
// Legend List default; a larger buffer exhausted the container pool at this
// scroll speed and forced on-demand container creation mid-scroll.
const DRAW_DISTANCE = 250;

const styles = StyleSheet.create({
  row: {
    height: ROW_HEIGHT,
    paddingVertical: 5,
    paddingHorizontal: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
    overflow: 'hidden',
  },
  rowTitle: { fontWeight: 'bold', fontSize: 12 },
  rowMeta: { fontSize: 11 },
});

// Memoized so a patched setRows() (new array, mostly the same row object
// references) re-renders only the rows whose reference actually changed.
const BenchRow = memo(function BenchRow({ item }: { item: Row }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowTitle} numberOfLines={1}>
        {item.fields.first_name} {item.fields.last_name} — {item.fields.company}
      </Text>
      <Text style={styles.rowMeta} numberOfLines={1}>
        ${item.fields.balance} · {item.fields.status} · {item.fields.updated_at}
      </Text>
    </View>
  );
});

export function BenchList() {
  const [rows, setRows] = useState<Row[]>([]);
  const [version, setVersion] = useState(0);
  const listRef = useRef<LegendListRef>(null);
  const commitResolvers = useRef<Array<() => void>>([]);
  const offset = useRef(0);
  const scrollRaf = useRef<number | null>(null);

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
        if (scrollRaf.current !== null) return;
        let last = performance.now();
        const step = (now: number) => {
          scrollRaf.current = requestAnimationFrame(step);
          const dt = Math.min(100, now - last); // clamp across stalls
          last = now;
          const list = listRef.current;
          if (!list) return;
          const state = list.getState();
          const maxOffset = Math.max(0, (state?.contentLength ?? 0) - (state?.scrollLength ?? 0));
          const next = offset.current + SCROLL_PX_PER_MS * dt;
          offset.current = next > maxOffset ? 0 : next;
          list.scrollToOffset({ offset: offset.current, animated: false });
        };
        scrollRaf.current = requestAnimationFrame(step);
      },
      stopScroll: () => {
        if (scrollRaf.current !== null) cancelAnimationFrame(scrollRaf.current);
        scrollRaf.current = null;
      },
    });
    return () => {
      if (scrollRaf.current !== null) cancelAnimationFrame(scrollRaf.current);
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
        estimatedItemSize={ROW_HEIGHT}
        drawDistance={DRAW_DISTANCE}
        recycleItems
        renderItem={({ item }: { item: Row }) => <BenchRow item={item} />}
      />
    </View>
  );
}
