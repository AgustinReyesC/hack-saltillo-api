import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { EntityManager } from 'typeorm';
import { EventEnvelope } from './event-envelope.js';

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

  // Se encola dentro de la misma transacción que el cambio; el publicador a SQS lo envía después.
  async save(manager: EntityManager, envelope: EventEnvelope): Promise<void> {
    await manager.query(
      `INSERT INTO outbox_event
         (event_id, event_type, event_version, occurred_at, source, event_key, topic, payload)
       VALUES ($1, $2, $3, $4, $5, $6, 'inventory.events', $7)`,
      [
        envelope.event_id,
        envelope.event_type,
        envelope.event_version,
        envelope.occurred_at,
        envelope.source,
        envelope.key,
        JSON.stringify(envelope),
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
