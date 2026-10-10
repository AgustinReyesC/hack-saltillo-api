// Sobre de los eventos, igual para entrada y salida (contract/README.md §1).
export interface EventEnvelope<T extends object = object> {
  event_id: string;
  event_type: string;
  event_version: number;
  occurred_at: string;
  source: string;
  key: string;
  data: T;
}
