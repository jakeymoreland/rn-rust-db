export type EventEmitter<T> = {
  addListener(fn: (e: T) => void): { remove(): void };
};
