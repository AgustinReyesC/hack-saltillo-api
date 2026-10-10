import { Module } from '@nestjs/common';
import { CatalogHandlers } from './catalog.handlers.js';

@Module({
  providers: [CatalogHandlers],
  exports: [CatalogHandlers],
})
export class CatalogModule {}
