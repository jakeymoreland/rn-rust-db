import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';
import type { EventEmitter } from 'react-native/Libraries/Types/CodegenTypes';

export type ChangeEvent = {
  channel: string;
  payload: string; // BatchSummary JSON
};

export interface Spec extends TurboModule {
  open(path: string): void;
  close(): void;
  execute(requestJson: string): Promise<string>;
  executeSync(requestJson: string): string;
  /** Installs global.__reconcileEngine fast-path JSI functions. */
  installFastPath(): boolean;
  readonly onChange: EventEmitter<ChangeEvent>;
}

export default TurboModuleRegistry.getEnforcing<Spec>('NativeReconcileEngine');
