import { Module } from '@nestjs/common';
import { CommitmentsModule } from '../commitments/commitments.module.js';
import { LedgerModule } from '../ledger/ledger.module.js';
import { OutboxModule } from '../outbox/outbox.module.js';
import { RealtimeModule } from '../realtime/realtime.module.js';
import { PurchasingController } from './purchasing.controller.js';
import { PurchasingService } from './purchasing.service.js';

@Module({
  imports: [LedgerModule, OutboxModule, CommitmentsModule, RealtimeModule],
  controllers: [PurchasingController],
  providers: [PurchasingService],
})
export class PurchasingModule {}
