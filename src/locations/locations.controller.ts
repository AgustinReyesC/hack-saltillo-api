import { Controller, Get, Param, Query } from '@nestjs/common';
import { IntIdPipe } from '../common/pipes/int-id.pipe.js';
import {
  LocationsQueryDto,
  StockBalancesQueryDto,
} from './dto/locations-query.dto.js';
import { LocationsService } from './locations.service.js';

@Controller()
export class LocationsController {
  constructor(private readonly locationsService: LocationsService) {}

  @Get('locations')
  list(@Query() query: LocationsQueryDto) {
    return this.locationsService.list(query);
  }

  @Get('locations/:location_id/stock')
  stock(@Param('location_id', new IntIdPipe('Location')) locationId: number) {
    return this.locationsService.stock(locationId);
  }

  @Get('stock-balances')
  balances(@Query() query: StockBalancesQueryDto) {
    return this.locationsService.balances(query);
  }
}
