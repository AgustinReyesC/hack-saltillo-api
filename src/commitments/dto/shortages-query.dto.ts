import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString } from 'class-validator';

export class ShortagesQueryDto {
  @IsOptional()
  @IsString()
  work_order_code?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  part_id?: number;
}
