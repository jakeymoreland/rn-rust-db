export const mockNative = {
  open: jest.fn(),
  close: jest.fn(),
  execute: jest.fn(),
  executeSync: jest.fn(),
  installFastPath: jest.fn(() => true),
  onChange: {
    listeners: [] as Array<(e: { channel: string; payload: string }) => void>,
    addListener(fn: (e: { channel: string; payload: string }) => void) {
      this.listeners.push(fn);
      return { remove: () => { this.listeners = this.listeners.filter((l) => l !== fn); } };
    },
    emit(e: { channel: string; payload: string }) {
      this.listeners.forEach((l) => l(e));
    },
  },
};

export const TurboModuleRegistry = {
  getEnforcing: () => mockNative,
};
export type TurboModule = object;
