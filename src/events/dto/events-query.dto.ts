import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export class EventsQueryDto {
  // `inbox` = consumidos de SQS, `outbox` = generados por la API, `dlq` = no procesables. No se
  // llama `source` para no confundirse con el `source` del sobre (`shop-floor` / `inventory`).
  @IsOptional()
  @IsIn(['inbox', 'outbox', 'dlq'])
  origin?: string;

  @IsOptional()
  @IsString()
  type?: string;

  // inbox: received|processed|failed · outbox: pending|published · dlq: dead
  @IsOptional()
  @IsString()
  status?: string;

  // shop.catalog … notifications (inbox), inventory.events / inventory.dlq (outbox).
  @IsOptional()
  @IsString()
  topic?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number;
}
