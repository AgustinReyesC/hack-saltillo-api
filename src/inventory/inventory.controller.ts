import { Body, Controller, Post } from '@nestjs/common';
import { CountDto } from './dto/count.dto.js';
import { IssueDto } from './dto/issue.dto.js';
import { TransferDto } from './dto/transfer.dto.js';
import { InventoryService } from './inventory.service.js';

@Controller()
export class InventoryController {
  constructor(private readonly inventoryService: InventoryService) {}

  @Post('counts')
  count(@Body() body: CountDto) {
    return this.inventoryService.count(body);
  }

  @Post('transfers')
  transfer(@Body() body: TransferDto) {
    return this.inventoryService.transfer(body);
  }

  @Post('issues')
  issue(@Body() body: IssueDto) {
    return this.inventoryService.issue(body);
  }
}
