import { Body, Controller, Get, Param, Patch, Query } from '@nestjs/common';
import { IntIdPipe } from '../common/pipes/int-id.pipe.js';
import { PartInstancesQueryDto } from './dto/part-instances-query.dto.js';
import { UpdatePartInstanceDto } from './dto/update-part-instance.dto.js';
import { PartInstancesService } from './part-instances.service.js';

const instanceIdPipe = new IntIdPipe('Part instance', Number.MAX_SAFE_INTEGER);

@Controller('part-instances')
export class PartInstancesController {
  constructor(private readonly partInstancesService: PartInstancesService) {}

  @Get()
  list(@Query() query: PartInstancesQueryDto) {
    return this.partInstancesService.list(query);
  }

  @Get(':instance_id')
  get(@Param('instance_id', instanceIdPipe) instanceId: number) {
    return this.partInstancesService.get(instanceId);
  }

  @Patch(':instance_id')
  update(
    @Param('instance_id', instanceIdPipe) instanceId: number,
    @Body() body: UpdatePartInstanceDto,
  ) {
    return this.partInstancesService.update(instanceId, body);
  }
}
