type ChangeEvent = { channel: string; payload: string };

function makeOnChange() {
  const onChange = (fn: (e: ChangeEvent) => void) => {
    onChange.listeners.push(fn);
    return { remove: () => { onChange.listeners = onChange.listeners.filter((l) => l !== fn); } };
  };
  onChange.listeners = [] as Array<(e: ChangeEvent) => void>;
  onChange.emit = (e: ChangeEvent) => {
    onChange.listeners.forEach((l) => l(e));
  };
  return onChange;
}

export const mockNative = {
  open: jest.fn(),
  close: jest.fn(),
  execute: jest.fn(),
  executeSync: jest.fn(),
  ingestDirect: jest.fn(),
  installFastPath: jest.fn(() => true),
  // Matches the real TurboModule's runtime shape: `onChange` is itself a
  // callable subscribe function (`onChange(listener) => { remove() }`),
  // not an EventEmitter object with `.addListener`.
  onChange: makeOnChange(),
};

export const TurboModuleRegistry = {
  getEnforcing: () => mockNative,
};
export type TurboModule = object;
