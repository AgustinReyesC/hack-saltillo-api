import { IsNotEmpty, IsOptional, IsString, ValidateIf } from 'class-validator';
import { IsInt32 } from '../../common/validators.js';

// `PATCH /part-instances/{instance_id}`: solo se cambian los campos enviados; `null` limpia
// el campo (salvo `condition_code`, obligatorio en la base).
export class UpdatePartInstanceDto {
  // Se valida contra `part_condition`, no contra una lista fija.
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  condition_code?: string;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsInt32()
  location_id?: number | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsInt32()
  work_order_id?: number | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  serial_number?: string | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  note?: string | null;
}

export const PART_INSTANCE_FIELDS = [
  'condition_code',
  'location_id',
  'work_order_id',
  'serial_number',
  'note',
] as const;
