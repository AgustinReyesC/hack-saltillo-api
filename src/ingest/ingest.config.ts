import { ConfigService } from '@nestjs/config';
import {
  INVENTORY_DLQ_TOPIC,
  INVENTORY_EVENTS_TOPIC,
} from '../outbox/outbox.service.js';

export const CATALOG_TOPIC = 'shop.catalog';
export const PURCHASING_TOPIC = 'shop.purchasing';
export const NOTIFICATIONS_TOPIC = 'notifications';

export const INGEST_CONFIG = Symbol('INGEST_CONFIG');

export interface QueueConfig {
  topic: string;
  url: string;
}

export interface IngestConfig {
  region: string | undefined;
  // Solo para un emulador local (ElasticMQ); en AWS se deja vacío.
  endpoint: string | undefined;
  // Colas de entrada configuradas, en el orden del contrato (catálogo primero).
  inputs: QueueConfig[];
  // Tópico lógico de salida → URL de su cola.
  outputs: Map<string, string>;
  // Minutos que un evento puede esperar una dependencia antes de ir a la DLQ (regla 21).
  maxWaitMinutes: number;
  // Intentos de un evento que falla por otra causa antes de ir a la DLQ.
  maxAttempts: number;
  retryIntervalMs: number;
  publishIntervalMs: number;
  agentUrl: string | undefined;
}

// Variable de entorno → tópico lógico (el nombre que usan los schemas del contrato).
const INPUT_QUEUES: [string, string][] = [
  ['SQS_SHOP_CATALOG_URL', CATALOG_TOPIC],
  ['SQS_SHOP_WORK_ORDERS_URL', 'shop.work_orders'],
  ['SQS_SHOP_INSPECTIONS_URL', 'shop.inspections'],
  ['SQS_SHOP_PURCHASING_URL', PURCHASING_TOPIC],
  ['SQS_NOTIFICATIONS_URL', NOTIFICATIONS_TOPIC],
];
const OUTPUT_QUEUES: [string, string][] = [
  ['SQS_INVENTORY_EVENTS_URL', INVENTORY_EVENTS_TOPIC],
  ['SQS_INVENTORY_DLQ_URL', INVENTORY_DLQ_TOPIC],
];

export function loadIngestConfig(config: ConfigService): IngestConfig {
  const text = (name: string) => config.get<string>(name)?.trim() || undefined;
  const number = (name: string, fallback: number) => {
    const value = Number(text(name) ?? fallback);
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`${name} debe ser un número positivo`);
    }
    return value;
  };

  const inputs = INPUT_QUEUES.flatMap(([variable, topic]) => {
    const url = text(variable);
    return url ? [{ topic, url }] : [];
  });
  const outputs = new Map(
    OUTPUT_QUEUES.flatMap(([variable, topic]) => {
      const url = text(variable);
      return url ? [[topic, url] as [string, string]] : [];
    }),
  );

  const region = text('AWS_REGION');
  if ((inputs.length > 0 || outputs.size > 0) && !region) {
    throw new Error(
      'AWS_REGION es obligatorio cuando hay colas SQS configuradas',
    );
  }

  return {
    region,
    endpoint: text('SQS_ENDPOINT_URL'),
    inputs,
    outputs,
    maxWaitMinutes: number('INGEST_MAX_WAIT_MINUTES', 60),
    maxAttempts: number('INGEST_MAX_ATTEMPTS', 5),
    retryIntervalMs: number('INGEST_RETRY_INTERVAL_MS', 5000),
    publishIntervalMs: number('OUTBOX_PUBLISH_INTERVAL_MS', 250),
    agentUrl: text('AGENT_URL'),
  };
}
