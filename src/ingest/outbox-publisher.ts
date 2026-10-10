import {
  SendMessageBatchCommand,
  SendMessageBatchRequestEntry,
  SQSClient,
} from '@aws-sdk/client-sqs';
import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { INGEST_CONFIG, type IngestConfig } from './ingest.config.js';
import { SQS_CLIENT } from './sqs.client.js';

// SendMessageBatch admite hasta 10 mensajes.
const BATCH_SIZE = 10;

interface OutboxRow {
  event_id: string;
  event_key: string;
  topic: string;
  payload: unknown;
}

// Publica `outbox_event` en las colas de salida (`inventory.events` y `inventory.dlq`). Primero
// publica y luego marca: un reinicio entre ambos repite el mensaje con el mismo `event_id`, que
// SQS FIFO descarta por `MessageDeduplicationId` dentro de 5 minutos (entrega al menos una vez).
@Injectable()
export class OutboxPublisher
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(OutboxPublisher.name);
  private timer?: NodeJS.Timeout;
  private flushing: Promise<void> | null = null;
  private again = false;
  private stopped = false;

  constructor(
    private readonly dataSource: DataSource,
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient | null,
    @Inject(INGEST_CONFIG) private readonly config: IngestConfig,
  ) {}

  private get enabled(): boolean {
    return this.sqs !== null && this.config.outputs.size > 0;
  }

  onApplicationBootstrap(): void {
    if (!this.enabled) {
      this.logger.warn(
        'Publicación desactivada: falta SQS_INVENTORY_EVENTS_URL; los eventos se quedan en outbox_event.',
      );
      return;
    }
    this.timer = setInterval(() => this.kick(), this.config.publishIntervalMs);
    this.kick();
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    await this.flushing;
  }

  // Pide publicar ya (después de un COMMIT con eventos nuevos); si ya está publicando, repite al
  // terminar.
  kick(): void {
    if (!this.enabled || this.stopped) {
      return;
    }
    if (this.flushing) {
      this.again = true;
      return;
    }
    this.flushing = this.flush()
      .catch((error: Error) =>
        this.logger.error(`No se pudo publicar outbox_event: ${error.message}`),
      )
      .finally(() => {
        this.flushing = null;
        if (this.again) {
          this.again = false;
          this.kick();
        }
      });
  }

  private async flush(): Promise<void> {
    while (!this.stopped && (await this.publishBatch()) === BATCH_SIZE) {
      // Sigue mientras haya lotes llenos.
    }
  }

  private async publishBatch(): Promise<number> {
    return this.dataSource.transaction(async (manager) => {
      const rows: OutboxRow[] = await manager.query(
        `SELECT event_id, event_key, topic, payload
         FROM outbox_event
         WHERE published_at IS NULL AND topic = ANY($1::text[])
         ORDER BY created_at, event_id
         LIMIT $2
         FOR UPDATE SKIP LOCKED`,
        [[...this.config.outputs.keys()], BATCH_SIZE],
      );
      const published: string[] = [];
      for (const [topic, group] of groupByTopic(rows)) {
        published.push(...(await this.send(topic, group)));
      }
      if (published.length > 0) {
        await manager.query(
          'UPDATE outbox_event SET published_at = now() WHERE event_id = ANY($1::uuid[])',
          [published],
        );
      }
      return rows.length;
    });
  }

  // La llave del evento es el grupo FIFO (orden por llave) y su `event_id`, la deduplicación.
  private async send(topic: string, rows: OutboxRow[]): Promise<string[]> {
    const entries: SendMessageBatchRequestEntry[] = rows.map((row, index) => ({
      Id: String(index),
      MessageBody: JSON.stringify(row.payload),
      MessageGroupId: row.event_key,
      MessageDeduplicationId: row.event_id,
    }));
    const result = await this.sqs!.send(
      new SendMessageBatchCommand({
        QueueUrl: this.config.outputs.get(topic),
        Entries: entries,
      }),
    );
    for (const failure of result.Failed ?? []) {
      this.logger.warn(
        `SQS rechazó ${rows[Number(failure.Id)].event_id} (${topic}): ${failure.Code} ${failure.Message ?? ''}`,
      );
    }
    return (result.Successful ?? []).map(
      (success) => rows[Number(success.Id)].event_id,
    );
  }
}

function groupByTopic(rows: OutboxRow[]): Map<string, OutboxRow[]> {
  const groups = new Map<string, OutboxRow[]>();
  for (const row of rows) {
    groups.set(row.topic, [...(groups.get(row.topic) ?? []), row]);
  }
  return groups;
}
