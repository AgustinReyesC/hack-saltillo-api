import { Controller, Get, Param, Query } from '@nestjs/common';
import { WorkOrdersQueryDto } from './dto/work-orders-query.dto.js';
import { WorkOrdersService } from './work-orders.service.js';

@Controller('work-orders')
export class WorkOrdersController {
  constructor(private readonly workOrdersService: WorkOrdersService) {}

  @Get()
  list(@Query() query: WorkOrdersQueryDto) {
    return this.workOrdersService.list(query);
  }

  @Get(':code')
  get(@Param('code') code: string) {
    return this.workOrdersService.get(code);
  }

  @Get(':code/materials')
  materials(@Param('code') code: string) {
    return this.workOrdersService.materials(code);
  }
}
