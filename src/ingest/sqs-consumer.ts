import {
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  CATALOG_TOPIC,
  INGEST_CONFIG,
  type IngestConfig,
  PURCHASING_TOPIC,
  QueueConfig,
} from './ingest.config.js';
import { IngestService } from './ingest.service.js';
import { SQS_CLIENT } from './sqs.client.js';

const LONG_POLL_SECONDS = 20;
const ACTIVE_CATALOG_POLL_SECONDS = 1;
// El catálogo cuenta como activo si recibió mensajes en estos últimos milisegundos.
const CATALOG_ACTIVE_MS = 5000;
const ERROR_BACKOFF_MS = 2000;

// Consumidor en segundo plano de las colas de entrada (long polling). SQS no guarda offsets: un
// mensaje se borra solo después de quedar guardado en `event_inbox` (aplicado, pendiente o en la
// DLQ); si la API se cae antes, SQS lo vuelve a entregar al vencer su visibility timeout y el
// `event_id` evita aplicarlo dos veces.
@Injectable()
export class SqsConsumer
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(SqsConsumer.name);
  private readonly abort = new AbortController();
  private running?: Promise<void>;
  private stopped = false;
  // Barrera de compras (ver `catalogBarrier`).
  private lastCatalogMessageAt = 0;
  private catalogWaiters: { since: number; resolve: () => void }[] = [];

  constructor(
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient | null,
    @Inject(INGEST_CONFIG) private readonly config: IngestConfig,
    private readonly ingest: IngestService,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.sqs || this.config.inputs.length === 0) {
      this.logger.warn(
        'Consumo de SQS desactivado: no hay colas de entrada (SQS_SHOP_*_URL).',
      );
      return;
    }
    // En segundo plano: la API responde HTTP mientras lee el catálogo.
    this.running = this.run().catch((error: Error) =>
      this.logger.error(`El consumidor se detuvo: ${error.message}`),
    );
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    this.abort.abort();
    this.catalogReadDone(Number.POSITIVE_INFINITY);
    await this.running;
  }

  // Regla 22: el catálogo se lee hasta el final antes que las demás colas; si no, al reconstruir
  // las compras llegan antes que sus piezas y todas se van a revisión manual.
  private async run(): Promise<void> {
    const catalog = this.config.inputs.find(
      (queue) => queue.topic === CATALOG_TOPIC,
    );
    if (catalog) {
      this.logger.log('Leyendo shop.catalog completo antes de las demás colas');
      await this.drain(catalog);
      this.logger.log('Catálogo al día; inicia el consumo de todas las colas');
    }
    await Promise.all(this.config.inputs.map((queue) => this.poll(queue)));
  }

  // Lee hasta que la cola quede vacía. Los contadores de SQS son aproximados: se confirma con dos
  // lecturas vacías seguidas.
  private async drain(queue: QueueConfig): Promise<void> {
    let quiet = 0;
    while (!this.stopped && quiet < 2) {
      try {
        if ((await this.receive(queue, 1)) > 0) {
          quiet = 0;
          continue;
        }
        quiet = (await this.depth(queue)) === 0 ? quiet + 1 : 0;
      } catch (error) {
        if (this.stopped) {
          return;
        }
        this.logger.error(`${queue.topic}: ${(error as Error).message}`);
        await sleep(ERROR_BACKOFF_MS);
      }
    }
  }

  private async poll(queue: QueueConfig): Promise<void> {
    const isCatalog = queue.topic === CATALOG_TOPIC;
    while (!this.stopped) {
      const startedAt = Date.now();
      // Con el catálogo activo o compras esperando la barrera, lecturas cortas: así la barrera
      // espera a lo más un par de segundos y no un long poll completo.
      const wait =
        isCatalog && (this.catalogActive() || this.catalogWaiters.length > 0)
          ? ACTIVE_CATALOG_POLL_SECONDS
          : LONG_POLL_SECONDS;
      try {
        await this.receive(queue, wait);
      } catch (error) {
        if (this.stopped) {
          return;
        }
        this.logger.error(`${queue.topic}: ${(error as Error).message}`);
        await sleep(ERROR_BACKOFF_MS);
      }
      if (isCatalog) {
        this.catalogReadDone(startedAt);
      }
    }
  }

  // Regla 22 también en vivo: no hay orden entre colas, y una compra que se aplica antes que el
  // `part.upserted` que se publicó justo antes se relaciona contra un catálogo incompleto (queda sin
  // relacionar, o entra a una pieza cuando el `sku` era de dos). A diferencia de una inspección,
  // eso no se corrige al reintentar. Si el catálogo recibió algo hace poco, la compra espera a que
  // termine una lectura del catálogo que empezó después de que ella llegó.
  private async catalogBarrier(): Promise<void> {
    if (!this.catalogActive()) {
      return;
    }
    const since = Date.now();
    await new Promise<void>((resolve) =>
      this.catalogWaiters.push({ since, resolve }),
    );
  }

  private catalogActive(): boolean {
    return Date.now() - this.lastCatalogMessageAt < CATALOG_ACTIVE_MS;
  }

  private catalogReadDone(startedAt: number): void {
    this.catalogWaiters = this.catalogWaiters.filter((waiter) => {
      if (waiter.since > startedAt) {
        return true;
      }
      waiter.resolve();
      return false;
    });
  }

  // Los mensajes de una cola se procesan uno a uno y en orden: en una cola FIFO, SQS no entrega el
  // siguiente de un grupo mientras el anterior siga sin borrar.
  private async receive(
    queue: QueueConfig,
    waitSeconds: number,
  ): Promise<number> {
    const { Messages = [] } = await this.sqs!.send(
      new ReceiveMessageCommand({
        QueueUrl: queue.url,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: waitSeconds,
        MessageSystemAttributeNames: ['MessageGroupId'],
      }),
      { abortSignal: this.abort.signal },
    );
    if (Messages.length > 0 && queue.topic === CATALOG_TOPIC) {
      this.lastCatalogMessageAt = Date.now();
    }
    if (Messages.length > 0 && queue.topic === PURCHASING_TOPIC) {
      await this.catalogBarrier();
    }
    for (const message of Messages) {
      // Si la base no responde, `process` lanza y el mensaje no se borra.
      await this.ingest.process(queue.topic, parseBody(message.Body));
      await this.sqs!.send(
        new DeleteMessageCommand({
          QueueUrl: queue.url,
          ReceiptHandle: message.ReceiptHandle,
        }),
      );
    }
    return Messages.length;
  }

  private async depth(queue: QueueConfig): Promise<number> {
    const { Attributes = {} } = await this.sqs!.send(
      new GetQueueAttributesCommand({
        QueueUrl: queue.url,
        AttributeNames: [
          'ApproximateNumberOfMessages',
          'ApproximateNumberOfMessagesNotVisible',
        ],
      }),
    );
    return (
      Number(Attributes.ApproximateNumberOfMessages ?? 0) +
      Number(Attributes.ApproximateNumberOfMessagesNotVisible ?? 0)
    );
  }
}

// El cuerpo es el sobre del evento en JSON. Si viene como `{topic, event}` (el formato de
// `events.jsonl`), se desenvuelve. Lo que no es JSON pasa tal cual: el validador lo manda a la DLQ.
export function parseBody(body: string | undefined): unknown {
  let value: unknown;
  try {
    value = JSON.parse(body ?? '');
  } catch {
    return body ?? null;
  }
  if (
    value !== null &&
    typeof value === 'object' &&
    !('event_id' in value) &&
    'event' in value
  ) {
    return (value as { event: unknown }).event;
  }
  return value;
}
