import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsOptional, IsString } from 'class-validator';
import { IsInt32 } from '../../common/validators.js';

export class LocationsQueryDto {
  // Código exacto de la etiqueta (`U-101`), sin distinguir mayúsculas.
  @IsOptional()
  @IsString()
  code?: string;

  @IsOptional()
  @Transform(({ value }) =>
    value === 'true' ? true : value === 'false' ? false : value,
  )
  @IsBoolean()
  active?: boolean;
}

export class StockBalancesQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt32()
  location_id?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt32()
  part_id?: number;
}
