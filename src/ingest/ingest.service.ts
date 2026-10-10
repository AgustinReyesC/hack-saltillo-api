import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';
import { EventEnvelope } from '../outbox/event-envelope.js';
import {
  INVENTORY_DLQ_TOPIC,
  OutboxService,
} from '../outbox/outbox.service.js';
import { RealtimeGateway } from '../realtime/realtime.gateway.js';
import { AgentForwarder } from './agent-forwarder.js';
import { EnvelopeValidator } from './envelope-validator.js';
import { EventDispatcher } from './event-dispatcher.js';
import {
  INGEST_CONFIG,
  type IngestConfig,
  NOTIFICATIONS_TOPIC,
} from './ingest.config.js';
import {
  WaitingForPredecessorError,
  classifyFailure,
  describeError,
} from './ingest-errors.js';
import { OutboxPublisher } from './outbox-publisher.js';

// processed: aplicado · duplicate: ya estaba aplicado (regla 19) · failed: queda pendiente y se
// reintenta (regla 20) · dead: no se pudo procesar y se fue a la DLQ (regla 21).
export type IngestOutcome = 'processed' | 'duplicate' | 'failed' | 'dead';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Espera tras un evento aplicado antes de reintentar los pendientes: junta ráfagas.
const RETRY_DEBOUNCE_MS = 200;
const RETRY_BATCH = 500;

interface InboxState {
  status: string;
  received_at: Date;
}

// Pipeline de cada evento de entrada: validar el sobre, deduplicar contra `event_inbox`, aplicar
// su función en una transacción (dominio + `outbox_event` + `processed`, todo o nada) y avisar a
// la UI después del COMMIT. Lo que falla queda `failed` en `event_inbox`, que es la cola de
// reintentos; lo que no se puede procesar va a `dead_letter_event` y a `inventory.dlq`.
@Injectable()
export class IngestService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(IngestService.name);
  // Intentos de los eventos que fallan por un error (no por una dependencia) en este proceso.
  private readonly attempts = new Map<string, number>();
  private retryTimer?: NodeJS.Timeout;
  private retryScheduled?: NodeJS.Timeout;
  private retrying: Promise<void> | null = null;
  private retryAgain = false;
  // Al arrancar puede haber pendientes de una corrida anterior.
  private hasPending = true;
  private stopped = false;

  constructor(
    private readonly dataSource: DataSource,
    private readonly validator: EnvelopeValidator,
    private readonly dispatcher: EventDispatcher,
    private readonly outbox: OutboxService,
    private readonly realtime: RealtimeGateway,
    private readonly publisher: OutboxPublisher,
    private readonly agent: AgentForwarder,
    @Inject(INGEST_CONFIG) private readonly config: IngestConfig,
  ) {}

  onApplicationBootstrap(): void {
    this.retryTimer = setInterval(
      () => this.scheduleRetry(0),
      this.config.retryIntervalMs,
    );
    this.scheduleRetry(0);
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    clearInterval(this.retryTimer);
    clearTimeout(this.retryScheduled);
    await this.retrying;
  }

  // Procesa un evento tal cual llegó de la cola. Solo lanza si no pudo ni guardarlo (la base no
  // responde): así el consumidor no borra el mensaje y SQS lo vuelve a entregar.
  async process(topic: string, event: unknown): Promise<IngestOutcome> {
    const validation = this.validator.validate(topic, event);
    if (!validation.ok) {
      await this.deadLetter(topic, event, validation.error, 0);
      return 'dead';
    }
    const envelope = validation.envelope;

    let outputs: EventEnvelope[];
    try {
      const result = await this.dataSource.transaction((manager) =>
        this.apply(manager, topic, envelope),
      );
      if (result === 'duplicate') {
        return 'duplicate';
      }
      outputs = result;
    } catch (error) {
      return this.fail(topic, envelope, error);
    }

    this.attempts.delete(envelope.event_id);
    this.realtime.notify([envelope, ...outputs]);
    if (outputs.length > 0) {
      this.publisher.kick();
    }
    if (topic === NOTIFICATIONS_TOPIC) {
      void this.agent.forward(envelope);
    }
    // Un evento aplicado puede destrabar a los que esperaban algo (regla 20).
    this.scheduleRetry();
    return 'processed';
  }

  private async apply(
    manager: EntityManager,
    topic: string,
    envelope: EventEnvelope,
  ): Promise<EventEnvelope[] | 'duplicate'> {
    await manager.query(
      `INSERT INTO event_inbox
         (event_id, event_type, event_version, occurred_at, source, event_key, topic, payload, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'received')
       ON CONFLICT (event_id) DO NOTHING`,
      this.inboxValues(topic, envelope),
    );
    // Candado de la fila: dos entregas simultáneas del mismo `event_id` no se aplican dos veces.
    const [inbox]: InboxState[] = await manager.query(
      'SELECT status, received_at FROM event_inbox WHERE event_id = $1 FOR UPDATE',
      [envelope.event_id],
    );
    if (inbox.status === 'processed') {
      return 'duplicate';
    }

    // Orden por llave dentro del tópico: si uno anterior con la misma llave sigue pendiente,
    // este espera su turno (se reintentan por orden de llegada).
    const [earlier]: { event_id: string }[] = await manager.query(
      `SELECT i.event_id FROM event_inbox i
       WHERE i.topic = $1 AND i.event_key = $2 AND i.event_id <> $3
         AND i.status <> 'processed' AND i.received_at < $4
         AND NOT EXISTS (SELECT 1 FROM dead_letter_event d WHERE d.original_event_id = i.event_id)
       ORDER BY i.received_at
       LIMIT 1`,
      [topic, envelope.key, envelope.event_id, inbox.received_at],
    );
    if (earlier) {
      throw new WaitingForPredecessorError(earlier.event_id);
    }

    const outputs = await this.dispatcher.dispatch(manager, topic, envelope);
    await manager.query(
      `UPDATE event_inbox SET status = 'processed', processed_at = now(), error = NULL
       WHERE event_id = $1`,
      [envelope.event_id],
    );
    return outputs;
  }

  private async fail(
    topic: string,
    envelope: EventEnvelope,
    error: unknown,
  ): Promise<IngestOutcome> {
    const kind = classifyFailure(error);
    if (kind === 'connection') {
      throw error;
    }
    const message = describeError(error);
    // La transacción se revirtió: se guarda el evento como pendiente en una aparte.
    const [inbox]: InboxState[] = await this.dataSource.query(
      `INSERT INTO event_inbox
         (event_id, event_type, event_version, occurred_at, source, event_key, topic, payload,
          status, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'failed', $9)
       ON CONFLICT (event_id) DO UPDATE
         SET status = CASE WHEN event_inbox.status = 'processed' THEN 'processed' ELSE 'failed' END,
             error = CASE WHEN event_inbox.status = 'processed' THEN event_inbox.error
                          ELSE EXCLUDED.error END
       RETURNING status, received_at`,
      [...this.inboxValues(topic, envelope), message],
    );
    if (inbox.status === 'processed') {
      return 'duplicate';
    }
    this.hasPending = true;

    if (kind === 'error') {
      const attempts = (this.attempts.get(envelope.event_id) ?? 0) + 1;
      this.attempts.set(envelope.event_id, attempts);
      this.logger.warn(
        `${envelope.event_type} ${envelope.event_id} falló (intento ${attempts}): ${message}`,
      );
      if (attempts >= this.config.maxAttempts) {
        await this.deadLetter(topic, envelope, message, attempts);
        return 'dead';
      }
      return 'failed';
    }

    if (kind === 'dependency') {
      const waitedMs = Date.now() - new Date(inbox.received_at).getTime();
      if (waitedMs > this.config.maxWaitMinutes * 60_000) {
        await this.deadLetter(
          topic,
          envelope,
          `${message}; esperó más de ${this.config.maxWaitMinutes} min`,
          this.attempts.get(envelope.event_id) ?? 0,
        );
        return 'dead';
      }
      this.logger.debug(
        `${envelope.event_type} ${envelope.event_id} en espera: ${message}`,
      );
    }
    return 'failed';
  }

  // Regla 21: se guarda en `dead_letter_event` y el mensaje original se publica en
  // `inventory.dlq` con su misma llave. El consumo sigue.
  private async deadLetter(
    topic: string,
    event: unknown,
    error: string,
    retries: number,
  ): Promise<void> {
    const original = (event ?? {}) as Partial<
      Record<keyof EventEnvelope, unknown>
    >;
    const eventId =
      typeof original.event_id === 'string' && UUID_RE.test(original.event_id)
        ? original.event_id
        : null;
    const text = (value: unknown) =>
      typeof value === 'string' && value.length > 0 ? value : null;
    const occurredAt = text(original.occurred_at);

    await this.dataSource.transaction(async (manager) => {
      await manager.query(
        `INSERT INTO dead_letter_event
           (original_event_id, event_type, topic, event_key, payload, error, retries)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          eventId,
          text(original.event_type),
          topic,
          text(original.key),
          JSON.stringify(event ?? null),
          error,
          retries,
        ],
      );
      await this.outbox.save(
        manager,
        {
          event_id: eventId ?? randomUUID(),
          event_type: text(original.event_type) ?? 'unknown',
          event_version: Number.isInteger(original.event_version)
            ? (original.event_version as number)
            : 1,
          occurred_at:
            occurredAt && !Number.isNaN(Date.parse(occurredAt))
              ? occurredAt
              : new Date().toISOString(),
          source: text(original.source) ?? 'unknown',
          key: text(original.key) ?? 'unknown',
          data: {},
        },
        INVENTORY_DLQ_TOPIC,
        event,
      );
    });
    if (eventId) {
      this.attempts.delete(eventId);
    }
    this.logger.error(
      `Evento ${eventId ?? '(sin event_id)'} de ${topic} a la DLQ: ${error}`,
    );
    this.publisher.kick();
  }

  private inboxValues(topic: string, envelope: EventEnvelope): unknown[] {
    return [
      envelope.event_id,
      envelope.event_type,
      envelope.event_version,
      envelope.occurred_at,
      envelope.source,
      envelope.key,
      topic,
      JSON.stringify(envelope),
    ];
  }

  // Reintenta los pendientes. Un solo recorrido a la vez; los avisos que llegan mientras corre
  // piden otro al terminar.
  private scheduleRetry(delayMs = RETRY_DEBOUNCE_MS): void {
    if (this.stopped || !this.hasPending) {
      return;
    }
    if (this.retrying) {
      this.retryAgain = true;
      return;
    }
    if (this.retryScheduled) {
      return;
    }
    this.retryScheduled = setTimeout(() => {
      this.retryScheduled = undefined;
      this.retrying = this.runRetries()
        .catch((error: Error) =>
          this.logger.error(`Reintento interrumpido: ${error.message}`),
        )
        .finally(() => {
          this.retrying = null;
          if (this.retryAgain) {
            this.retryAgain = false;
            this.scheduleRetry();
          }
        });
    }, delayMs);
  }

  // Recorre los pendientes por orden de llegada hasta que una pasada no destrabe nada: una
  // pieza puede destrabar una lista de partes, que destraba una orden, que destraba su inspección.
  private async runRetries(): Promise<void> {
    let progress = true;
    while (progress && !this.stopped) {
      this.retryAgain = false;
      progress = await this.retryPass();
    }
  }

  private async retryPass(): Promise<boolean> {
    const rows: { topic: string | null; payload: unknown }[] =
      await this.dataSource.query(
        `SELECT i.topic, i.payload FROM event_inbox i
         WHERE i.status <> 'processed'
           AND NOT EXISTS (SELECT 1 FROM dead_letter_event d WHERE d.original_event_id = i.event_id)
         ORDER BY i.received_at, i.event_id
         LIMIT $1`,
        [RETRY_BATCH],
      );
    if (rows.length === 0) {
      this.hasPending = false;
      return false;
    }
    let progress = false;
    for (const row of rows) {
      if (this.stopped) {
        break;
      }
      const outcome = await this.process(row.topic ?? '', row.payload);
      progress ||= outcome !== 'failed';
    }
    return progress;
  }
}
