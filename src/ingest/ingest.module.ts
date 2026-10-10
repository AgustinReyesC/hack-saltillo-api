import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AgentModule } from '../agent/agent.module.js';
import { CatalogModule } from '../catalog/catalog.module.js';
import { InspectionsModule } from '../inspections/inspections.module.js';
import { OutboxModule } from '../outbox/outbox.module.js';
import { PurchasingModule } from '../purchasing/purchasing.module.js';
import { RealtimeModule } from '../realtime/realtime.module.js';
import { WorkOrdersModule } from '../work-orders/work-orders.module.js';
import { AgentForwarder } from './agent-forwarder.js';
import { EnvelopeValidator } from './envelope-validator.js';
import { EventDispatcher } from './event-dispatcher.js';
import {
  INGEST_CONFIG,
  IngestConfig,
  loadIngestConfig,
} from './ingest.config.js';
import { IngestService } from './ingest.service.js';
import { OutboxPublisher } from './outbox-publisher.js';
import { SQS_CLIENT, createSqsClient } from './sqs.client.js';
import { SqsConsumer } from './sqs-consumer.js';

// Consumo de las colas de entrada, pipeline de eventos y publicación de las colas de salida.
@Module({
  imports: [
    AgentModule,
    OutboxModule,
    RealtimeModule,
    CatalogModule,
    WorkOrdersModule,
    InspectionsModule,
    PurchasingModule,
  ],
  providers: [
    {
      provide: INGEST_CONFIG,
      inject: [ConfigService],
      useFactory: loadIngestConfig,
    },
    {
      provide: SQS_CLIENT,
      inject: [INGEST_CONFIG],
      useFactory: (config: IngestConfig) => createSqsClient(config),
    },
    EnvelopeValidator,
    EventDispatcher,
    AgentForwarder,
    OutboxPublisher,
    IngestService,
    SqsConsumer,
  ],
  exports: [IngestService, EnvelopeValidator],
})
export class IngestModule {}
