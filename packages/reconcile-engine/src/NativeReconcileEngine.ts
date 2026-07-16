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
  /**
   * Ingest without the JSON command envelope: the payload crosses the
   * boundary as a plain string argument instead of being re-escaped into a
   * request envelope and parsed twice. Returns the same response envelope
   * as execute('ingest').
   */
  ingestDirect(sourceId: string, payload: string): Promise<string>;
  /** Installs global.__reconcileEngine fast-path JSI functions. */
  installFastPath(): boolean;
  readonly onChange: EventEmitter<ChangeEvent>;
}

export default TurboModuleRegistry.getEnforcing<Spec>('NativeReconcileEngine');
