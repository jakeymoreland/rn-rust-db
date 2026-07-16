import type { Row } from './decode';

export type ListDriver = {
  setRows(rows: Row[]): Promise<void>; // resolves after React commit
  startScroll(): void; // constant-velocity loop, wraps at end
  stopScroll(): void;
};

let driver: ListDriver | null = null;

export const registerListDriver = (d: ListDriver | null): void => {
  driver = d;
};

export async function waitForListDriver(timeoutMs: number): Promise<ListDriver | null> {
  const t0 = performance.now();
  while (!driver && performance.now() - t0 < timeoutMs) {
    await new Promise((r) => setTimeout(r, 50));
  }
  return driver;
}
