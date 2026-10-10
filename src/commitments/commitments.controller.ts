import { Controller, Get, Query } from '@nestjs/common';
import { CommitmentsService } from './commitments.service.js';
import { ShortagesQueryDto } from './dto/shortages-query.dto.js';

@Controller()
export class CommitmentsController {
  constructor(private readonly commitmentsService: CommitmentsService) {}

  @Get('shortages')
  listShortages(@Query() query: ShortagesQueryDto) {
    return this.commitmentsService.listShortages(query);
  }

  @Get('reorder-suggestions')
  listReorderSuggestions() {
    return this.commitmentsService.listReorderSuggestions();
  }
}
