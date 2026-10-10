import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import { IntIdPipe } from '../common/pipes/int-id.pipe.js';
import { CreatePurchaseOrderDto } from './dto/create-purchase-order.dto.js';
import { ResolveReceiptDto } from './dto/resolve-receipt.dto.js';
import { PurchasingService } from './purchasing.service.js';

@Controller()
export class PurchasingController {
  constructor(private readonly purchasingService: PurchasingService) {}

  @Get('unmatched-receipts')
  listUnmatchedReceipts() {
    return this.purchasingService.listUnmatchedReceipts();
  }

  @Post('unmatched-receipts/:id/resolve')
  @HttpCode(HttpStatus.OK)
  resolveReceipt(
    @Param('id', new IntIdPipe('Unmatched receipt', Number.MAX_SAFE_INTEGER))
    id: number,
    @Body() body: ResolveReceiptDto,
  ) {
    return this.purchasingService.resolveReceipt(id, body);
  }

  @Get('suppliers')
  listSuppliers() {
    return this.purchasingService.listSuppliers();
  }

  @Post('purchase-orders')
  createPurchaseOrder(@Body() body: CreatePurchaseOrderDto) {
    return this.purchasingService.createPurchaseOrder(body);
  }
}
