import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { EntityManager } from 'typeorm';
import { EventEnvelope } from './event-envelope.js';

// Tópicos lógicos de salida; el publicador los traduce a la URL de su cola.
export const INVENTORY_EVENTS_TOPIC = 'inventory.events';
export const INVENTORY_DLQ_TOPIC = 'inventory.dlq';

@Injectable()
export class OutboxService {
  // Crea el sobre de un evento de salida. Se separa de `save` para que el movimiento que lo
  // origina pueda guardar su `event_id`.
  build<T extends object>(
    eventType: string,
    key: string,
    data: T,
  ): EventEnvelope<T> {
    return {
      event_id: randomUUID(),
      event_type: eventType,
      event_version: 1,
      occurred_at: new Date().toISOString(),
      source: 'inventory',
      key,
      data,
    };
  }

  // Se encola dentro de la misma transacción que el cambio; el publicador lo envía después.
  // `created_at` con `clock_timestamp()` (no `now()`, que es el inicio de la transacción) para
  // publicar en el orden en que se generaron los eventos de una misma transacción. `payload` es
  // lo que se publica: el sobre, salvo en la DLQ, que lleva el mensaje original tal cual llegó.
  async save(
    manager: EntityManager,
    envelope: EventEnvelope,
    topic = INVENTORY_EVENTS_TOPIC,
    payload: unknown = envelope,
  ): Promise<void> {
    await manager.query(
      `INSERT INTO outbox_event
         (event_id, event_type, event_version, occurred_at, source, event_key, topic, payload,
          created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, clock_timestamp())
       ON CONFLICT (event_id) DO NOTHING`,
      [
        envelope.event_id,
        envelope.event_type,
        envelope.event_version,
        envelope.occurred_at,
        envelope.source,
        envelope.key,
        topic,
        JSON.stringify(payload ?? null),
      ],
    );
  }

  async enqueue<T extends object>(
    manager: EntityManager,
    eventType: string,
    key: string,
    data: T,
  ): Promise<EventEnvelope<T>> {
    const envelope = this.build(eventType, key, data);
    await this.save(manager, envelope);
    return envelope;
  }
}
