import { Module } from '@nestjs/common';
import { PartInstancesController } from './part-instances.controller.js';
import { PartInstancesService } from './part-instances.service.js';

@Module({
  controllers: [PartInstancesController],
  providers: [PartInstancesService],
})
export class PartInstancesModule {}
