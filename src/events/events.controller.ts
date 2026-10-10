import { Controller, Get, Query } from '@nestjs/common';
import { EventsQueryDto } from './dto/events-query.dto.js';
import { EventsService } from './events.service.js';

@Controller('events')
export class EventsController {
  constructor(private readonly eventsService: EventsService) {}

  @Get()
  list(@Query() query: EventsQueryDto) {
    return this.eventsService.list(query);
  }
}
