import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module.js';
import { OutboxModule } from '../outbox/outbox.module.js';
import { CommitmentsController } from './commitments.controller.js';
import { CommitmentsService } from './commitments.service.js';

@Module({
  imports: [LedgerModule, OutboxModule],
  controllers: [CommitmentsController],
  providers: [CommitmentsService],
  exports: [CommitmentsService],
})
export class CommitmentsModule {}
