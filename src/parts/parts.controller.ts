import { Body, Controller, Get, Param, Patch, Query } from '@nestjs/common';
import { IntIdPipe } from '../common/pipes/int-id.pipe.js';
import { PartsQueryDto } from './dto/parts-query.dto.js';
import { UpdateReorderPolicyDto } from './dto/update-reorder-policy.dto.js';
import { PartsService } from './parts.service.js';

@Controller('parts')
export class PartsController {
  constructor(private readonly partsService: PartsService) {}

  @Get()
  list(@Query() query: PartsQueryDto) {
    return this.partsService.list(query);
  }

  @Get(':part_id')
  get(@Param('part_id', new IntIdPipe('Part')) partId: number) {
    return this.partsService.get(partId);
  }

  @Get(':part_id/availability')
  availability(@Param('part_id', new IntIdPipe('Part')) partId: number) {
    return this.partsService.availability(partId);
  }

  @Get(':part_id/ledger')
  ledger(@Param('part_id', new IntIdPipe('Part')) partId: number) {
    return this.partsService.ledgerEntries(partId);
  }

  @Patch(':part_id')
  updateReorderPolicy(
    @Param('part_id', new IntIdPipe('Part')) partId: number,
    @Body() body: UpdateReorderPolicyDto,
  ) {
    return this.partsService.updateReorderPolicy(partId, body);
  }
}
