import { Type } from 'class-transformer';
import {
  IsArray,
  IsInt,
  IsString,
  Matches,
  Min,
  ValidateNested,
} from 'class-validator';
import { IsInt32 } from '../../common/validators.js';

export class CountLineDto {
  @IsInt32()
  part_id: number;

  @IsInt()
  @Min(0)
  counted_quantity: number;
}

export class CountDto {
  @IsInt32()
  location_id: number;

  // Motivo obligatorio: sin él, 422 (regla 17).
  @IsString()
  @Matches(/\S/, { message: 'reason should not be empty' })
  reason: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CountLineDto)
  lines: CountLineDto[];
}
