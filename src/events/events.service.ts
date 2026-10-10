import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { toIso } from '../common/serialization.js';
import { EventsQueryDto } from './dto/events-query.dto.js';

const DEFAULT_LIMIT = 50;

interface EventRow {
  source: string;
  event_id: string | null;
  event_type: string | null;
  topic: string | null;
  key: string | null;
  status: string;
  error: string | null;
  retries: number | null;
  occurred_at: Date | null;
  recorded_at: Date;
  payload: unknown;
}

// Lista lo consumido (`event_inbox`), lo generado (`outbox_event`) y lo no procesable
// (`dead_letter_event`). Solo lectura: el consumo de SQS no es una ruta HTTP.
@Injectable()
export class EventsService {
  constructor(private readonly dataSource: DataSource) {}

  async list(query: EventsQueryDto) {
    const rows: EventRow[] = await this.dataSource.query(
      `SELECT * FROM (
         SELECT 'inbox' AS source, event_id::text, event_type, topic, event_key AS key,
                status, error, NULL::int AS retries, occurred_at, received_at AS recorded_at, payload
         FROM event_inbox
         UNION ALL
         SELECT 'outbox', event_id::text, event_type, topic, event_key,
                CASE WHEN published_at IS NULL THEN 'pending' ELSE 'published' END,
                NULL, NULL, occurred_at, created_at, payload
         FROM outbox_event
         UNION ALL
         SELECT 'dlq', original_event_id::text, event_type, topic, event_key,
                'dead', error, retries, NULL, created_at, payload
         FROM dead_letter_event
       ) e
       WHERE ($1::text IS NULL OR e.source = $1)
         AND ($2::text IS NULL OR e.event_type = $2)
         AND ($3::text IS NULL OR e.status = $3)
         AND ($4::text IS NULL OR e.topic = $4)
       ORDER BY e.recorded_at DESC
       LIMIT $5`,
      [
        query.source ?? null,
        query.type ?? null,
        query.status ?? null,
        query.topic ?? null,
        query.limit ?? DEFAULT_LIMIT,
      ],
    );
    return {
      items: rows.map((row) => ({
        ...row,
        occurred_at: toIso(row.occurred_at),
        recorded_at: toIso(row.recorded_at),
      })),
    };
  }
}
