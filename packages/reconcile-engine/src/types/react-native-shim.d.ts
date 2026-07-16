// Ambient type shim for the `react-native` peer dependency.
//
// This package deliberately does not depend on `react-native` (it is a
// peerDependency only, per the project's no-bridging-framework-deps
// constraint), so the real react-native type declarations aren't available
// to the TypeScript compiler when type-checking this package in isolation.
// These minimal ambient declarations describe just the surface used by
// `NativeReconcileEngine.ts`, so `tsc --noEmit` and ts-jest's type-checking
// pass can resolve the module without installing react-native as a
// devDependency. At runtime (jest), these imports are redirected to the
// mocks in `src/__tests__` via `moduleNameMapper`; in a real app, the
// genuine `react-native` package (and its real types) supersede this shim.

declare module 'react-native' {
  export type TurboModule = object;
  export const TurboModuleRegistry: {
    getEnforcing<T extends TurboModule>(name: string): T;
  };
}

declare module 'react-native/Libraries/Types/CodegenTypes' {
  export type EventEmitter<T> = {
    addListener(fn: (event: T) => void): { remove(): void };
  };
}
