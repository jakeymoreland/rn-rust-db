import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { LegendList, type LegendListRef } from '@legendapp/list/react-native';
import type { LazyRows } from './decode';

// ── bridge ────────────────────────────────────────────────────────────────
export type RealListDriver = {
  /** Swap the backing lazy view; resolves after the React commit. */
  setView(view: LazyRows): Promise<void>;
  startScroll(): void;
  stopScroll(): void;
};

let driver: RealListDriver | null = null;
let visibility: ((v: boolean) => void) | null = null;

export const registerRealListVisibility = (fn: ((v: boolean) => void) | null): void => {
  visibility = fn;
};
export const setRealListVisible = (v: boolean): void => visibility?.(v);
export async function waitForRealListDriver(timeoutMs: number): Promise<RealListDriver | null> {
  const t0 = performance.now();
  while (!driver && performance.now() - t0 < timeoutMs) {
    await new Promise((r) => setTimeout(r, 50));
  }
  return driver;
}

// ── component ─────────────────────────────────────────────────────────────
const SCROLL_PX_PER_MS = 0.5;
const ROW_HEIGHT = 44;

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

// Rows materialize from the lazy view ONLY when rendered — the whole list is
// backed by one zero-copy ArrayBuffer; ~20 visible rows ever become objects.
const RealRow = memo(
  function RealRow({ view, index }: { view: LazyRows; index: number }) {
    const item = view.row(index);
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
  },
  (a, b) => a.view === b.view && a.index === b.index,
);

export function RealAppList() {
  const [state, setState] = useState<{ view: LazyRows; v: number } | null>(null);
  const listRef = useRef<LegendListRef>(null);
  const commitResolvers = useRef<Array<() => void>>([]);
  const offset = useRef(0);
  const scrollRaf = useRef<number | null>(null);

  useEffect(() => {
    const resolvers = commitResolvers.current;
    commitResolvers.current = [];
    for (const r of resolvers) r();
  }, [state]);

  useEffect(() => {
    driver = {
      setView: (view: LazyRows) =>
        new Promise<void>((resolve) => {
          commitResolvers.current.push(resolve);
          setState((s) => ({ view, v: (s?.v ?? 0) + 1 }));
        }),
      startScroll: () => {
        if (scrollRaf.current !== null) return;
        let last = performance.now();
        const step = (now: number) => {
          scrollRaf.current = requestAnimationFrame(step);
          const dt = Math.min(100, now - last);
          last = now;
          const list = listRef.current;
          if (!list) return;
          const s = list.getState();
          const maxOffset = Math.max(0, (s?.contentLength ?? 0) - (s?.scrollLength ?? 0));
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
    };
    return () => {
      if (scrollRaf.current !== null) cancelAnimationFrame(scrollRaf.current);
      driver = null;
    };
  }, []);

  // Index-array data: numbers, not row objects. Rebuilt per view swap so
  // visible rows re-render against the new view; identity via index is stable
  // because live updates rewrite rows in place (count never changes mid-run).
  const indices = useMemo(() => (state ? Array.from({ length: state.view.length }, (_, i) => i) : []), [state]);

  return (
    <View style={{ flex: 1 }}>
      <Text style={{ fontFamily: 'monospace', fontSize: 12, padding: 8, backgroundColor: '#efe' }}>
        real-app list — {state ? `${state.view.length} rows, view v${state.v}` : 'hydrating…'}
      </Text>
      {state && (
        <LegendList
          ref={listRef}
          data={indices}
          keyExtractor={(i: number) => String(i)}
          estimatedItemSize={ROW_HEIGHT}
          recycleItems
          renderItem={({ item }: { item: number }) => <RealRow view={state.view} index={item} />}
        />
      )}
    </View>
  );
}
