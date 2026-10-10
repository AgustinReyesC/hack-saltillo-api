import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export class EventsQueryDto {
  // `inbox` = consumidos de SQS, `outbox` = generados por la API, `dlq` = no procesables.
  @IsOptional()
  @IsIn(['inbox', 'outbox', 'dlq'])
  source?: string;

  @IsOptional()
  @IsString()
  type?: string;

  // inbox: received|processed|failed · outbox: pending|published · dlq: dead
  @IsOptional()
  @IsString()
  status?: string;

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
