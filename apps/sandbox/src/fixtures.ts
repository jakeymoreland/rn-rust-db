import type { SourceConfig } from '@rn-experiments/reconcile-engine';

export const SOURCES: SourceConfig[] = [
  { source_id: 'api', format: 'Json', collection: 'people', natural_key_field: 'email', timestamp_field: 'updatedAt', priority: 10 },
  { source_id: 'csv', format: 'Csv', collection: 'people', natural_key_field: 'email', timestamp_field: null, priority: 5 },
  { source_id: 'device', format: 'Json', collection: 'people', natural_key_field: 'email', timestamp_field: null, priority: 20 },
];

export const API_PAYLOAD = JSON.stringify([
  { email: 'ann@x.com', name: 'Ann', city: 'Sydney', updatedAt: 2000 },
  { email: 'bob@x.com', name: 'Bob', city: 'Perth', updatedAt: 2000 },
]);

export const CSV_PAYLOAD = 'email,name,phone\nann@x.com,Annie,0400 111 222\ncarol@x.com,Carol,0400 333 444\n';

export function devicePayload(): string {
  return JSON.stringify([
    { email: 'ann@x.com', lastSeen: new Date().toISOString() },
  ]);
}
