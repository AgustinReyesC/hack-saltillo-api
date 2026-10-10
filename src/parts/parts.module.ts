import { Module } from '@nestjs/common';
import { CommitmentsModule } from '../commitments/commitments.module.js';
import { LedgerModule } from '../ledger/ledger.module.js';
import { RealtimeModule } from '../realtime/realtime.module.js';
import { PartsController } from './parts.controller.js';
import { PartsGateway } from './parts.gateway.js';
import { PartsService } from './parts.service.js';

@Module({
  imports: [LedgerModule, CommitmentsModule, RealtimeModule],
  controllers: [PartsController],
  providers: [PartsService, PartsGateway],
})
export class PartsModule {}
