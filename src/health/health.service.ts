import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';

export interface HealthStatus {
  status: 'ok';
  database: 'up';
  // Eventos de entrada que siguen sin aplicarse (esperan una dependencia o reintento).
  pending_events: number;
  // Eventos de salida en `outbox_event` sin publicar.
  unpublished_events: number;
  // Eventos que se fueron a la DLQ.
  dead_events: number;
}

interface HealthCounts {
  pending_events: number;
  unpublished_events: number;
  dead_events: number;
}

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  constructor(private readonly dataSource: DataSource) {}

  async check(): Promise<HealthStatus> {
    let counts: HealthCounts;
    try {
      // `COUNT` devuelve bigint y `pg` lo entrega como texto: se convierte a int en SQL.
      const rows: HealthCounts[] = await this.dataSource.query(`
        SELECT
          (SELECT COUNT(*)::int FROM event_inbox i
           WHERE i.status <> 'processed'
             AND NOT EXISTS (SELECT 1 FROM dead_letter_event d
                             WHERE d.original_event_id = i.event_id)) AS pending_events,
          (SELECT COUNT(*)::int FROM outbox_event WHERE published_at IS NULL) AS unpublished_events,
          (SELECT COUNT(*)::int FROM dead_letter_event) AS dead_events
      `);
      counts = rows[0];
    } catch (error) {
      this.logger.error(error instanceof Error ? error.message : String(error));
      throw new ServiceUnavailableException('Database unavailable');
    }

    return {
      status: 'ok',
      database: 'up',
      pending_events: counts.pending_events,
      unpublished_events: counts.unpublished_events,
      dead_events: counts.dead_events,
    };
  }
}
