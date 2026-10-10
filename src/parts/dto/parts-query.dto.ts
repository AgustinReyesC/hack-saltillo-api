import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

export const CONDITION_CODES = [
  'new',
  'functional',
  'defective',
  'under_repair',
  'scrapped',
] as const;

// Filtros de `GET /parts` y del mensaje `parts:list` por WebSocket.
export class PartsQueryDto {
  // Busca en `sku` y `name` (sin distinguir mayúsculas).
  @IsOptional()
  @IsString()
  q?: string;

  // `sku` exacto, ignorando mayúsculas y espacios al inicio y al final.
  @IsOptional()
  @IsString()
  sku?: string;

  // Tipos de pieza que tienen al menos una unidad en ese estado.
  @IsOptional()
  @IsIn(CONDITION_CODES)
  condition?: string;

  // `true` = con disponible > 0; `false` = sin disponible.
  @IsOptional()
  @Transform(({ value }) =>
    value === 'true' ? true : value === 'false' ? false : value,
  )
  @IsBoolean()
  available?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}
