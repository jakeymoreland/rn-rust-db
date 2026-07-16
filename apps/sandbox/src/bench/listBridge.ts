import type { Row } from './decode';

export type ListDriver = {
  setRows(rows: Row[]): Promise<void>; // resolves after React commit
  startScroll(): void; // constant-velocity loop, wraps at end
  stopScroll(): void;
};

let driver: ListDriver | null = null;
let visibilitySetter: ((visible: boolean) => void) | null = null;

export const registerListDriver = (d: ListDriver | null): void => {
  driver = d;
};

// The host screen registers a setter; the FlatList phases use it to swap the
// screen over to the dedicated list route (a VirtualizedList must not be
// nested inside the Experiments ScrollView).
export const registerListVisibility = (fn: ((visible: boolean) => void) | null): void => {
  visibilitySetter = fn;
};

export const setListVisible = (visible: boolean): void => {
  visibilitySetter?.(visible);
};

export async function waitForListDriver(timeoutMs: number): Promise<ListDriver | null> {
  const t0 = performance.now();
  while (!driver && performance.now() - t0 < timeoutMs) {
    await new Promise((r) => setTimeout(r, 50));
  }
  return driver;
}
