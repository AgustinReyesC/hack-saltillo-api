import { Module } from '@nestjs/common';
import { CommitmentsModule } from '../commitments/commitments.module.js';
import { WorkOrdersController } from './work-orders.controller.js';
import { WorkOrderHandlers } from './work-orders.handlers.js';
import { WorkOrdersService } from './work-orders.service.js';

@Module({
  imports: [CommitmentsModule],
  controllers: [WorkOrdersController],
  providers: [WorkOrdersService, WorkOrderHandlers],
  exports: [WorkOrderHandlers],
})
export class WorkOrdersModule {}
