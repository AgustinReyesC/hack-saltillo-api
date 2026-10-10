import { Controller, Get, Query } from '@nestjs/common';
import { ScanQueryDto } from './dto/scan-query.dto.js';
import { ScanService } from './scan.service.js';

// `GET /scan?code=<texto leído>`. Va en la query y no en la ruta: los `sku` traen diagonales.
@Controller('scan')
export class ScanController {
  constructor(private readonly scanService: ScanService) {}

  @Get()
  resolve(@Query() query: ScanQueryDto) {
    return this.scanService.resolve(query.code);
  }
}
