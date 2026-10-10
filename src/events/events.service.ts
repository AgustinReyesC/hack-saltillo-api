import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { toIso } from '../common/serialization.js';
import { EventsQueryDto } from './dto/events-query.dto.js';

const DEFAULT_LIMIT = 50;

interface EventRow {
  origin: string;
  event_id: string | null;
  event_type: string | null;
  topic: string | null;
  key: string | null;
  status: string;
  error: string | null;
  retries: number | null;
  recorded_at: Date;
  payload: unknown;
}

// Lista lo consumido (`event_inbox`), lo generado (`outbox_event`) y lo no procesable
// (`dead_letter_event`). Cada elemento es el sobre del evento tal cual (`event_id`, `event_type`,
// `occurred_at`, `source`, `key`, `data`, …) más de dónde salió (`origin`), su `topic` y su
// `status`. Solo lectura: el consumo de SQS no es una ruta HTTP.
@Injectable()
export class EventsService {
  constructor(private readonly dataSource: DataSource) {}

  async list(query: EventsQueryDto) {
    const rows: EventRow[] = await this.dataSource.query(
      `SELECT * FROM (
         SELECT 'inbox' AS origin, event_id::text, event_type, topic, event_key AS key,
                status, error, NULL::int AS retries, received_at AS recorded_at, payload
         FROM event_inbox
         UNION ALL
         SELECT 'outbox', event_id::text, event_type, topic, event_key,
                CASE WHEN published_at IS NULL THEN 'pending' ELSE 'published' END,
                NULL, NULL, created_at, payload
         FROM outbox_event
         UNION ALL
         SELECT 'dlq', original_event_id::text, event_type, topic, event_key,
                'dead', error, retries, created_at, payload
         FROM dead_letter_event
       ) e
       WHERE ($1::text IS NULL OR e.origin = $1)
         AND ($2::text IS NULL OR e.event_type = $2)
         AND ($3::text IS NULL OR e.status = $3)
         AND ($4::text IS NULL OR e.topic = $4)
       ORDER BY e.recorded_at DESC
       LIMIT $5`,
      [
        query.origin ?? null,
        query.type ?? null,
        query.status ?? null,
        query.topic ?? null,
        query.limit ?? DEFAULT_LIMIT,
      ],
    );
    return {
      items: rows.map(({ payload, recorded_at, ...meta }) => {
        // En la DLQ puede quedar algo que ni siquiera era un sobre: se devuelve aparte.
        const envelope =
          payload !== null &&
          typeof payload === 'object' &&
          !Array.isArray(payload)
            ? payload
            : { payload };
        return {
          ...envelope,
          event_id: meta.event_id,
          event_type: meta.event_type,
          key: meta.key,
          origin: meta.origin,
          topic: meta.topic,
          status: meta.status,
          error: meta.error,
          retries: meta.retries,
          recorded_at: toIso(recorded_at),
        };
      }),
    };
  }
}
