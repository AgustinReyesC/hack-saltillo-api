import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';

export interface HealthStatus {
  status: 'ok';
  database: 'up';
  pending_events: number;
  unpublished_events: number;
}

interface HealthCounts {
  pending_events: number;
  unpublished_events: number;
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
          (SELECT COUNT(*)::int FROM event_inbox WHERE status <> 'processed') AS pending_events,
          (SELECT COUNT(*)::int FROM outbox_event WHERE published_at IS NULL) AS unpublished_events
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
    };
  }
}
