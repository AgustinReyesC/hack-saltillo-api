import { Module } from '@nestjs/common';
import { CommitmentsModule } from '../commitments/commitments.module.js';
import { LedgerModule } from '../ledger/ledger.module.js';
import { OutboxModule } from '../outbox/outbox.module.js';
import { RealtimeModule } from '../realtime/realtime.module.js';
import { InventoryController } from './inventory.controller.js';
import { InventoryService } from './inventory.service.js';

@Module({
  imports: [LedgerModule, OutboxModule, CommitmentsModule, RealtimeModule],
  controllers: [InventoryController],
  providers: [InventoryService],
})
export class InventoryModule {}
