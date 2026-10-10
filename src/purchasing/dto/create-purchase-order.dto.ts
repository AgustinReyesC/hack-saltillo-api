import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Min,
  ValidateNested,
} from 'class-validator';
import { IsInt32 } from '../../common/validators.js';

export class PurchaseOrderLineDto {
  @IsInt32()
  part_id: number;

  // Si falta, el `sku` de la pieza (o `P-<part_id>` si no tiene).
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  part_number?: string;

  @IsInt()
  @Min(1)
  quantity: number;

  // Importe como texto decimal, p. ej. "1850.00".
  @IsString()
  @Matches(/^\d+(\.\d{1,2})?$/, {
    message: 'unit_price must be a decimal string like "1850.00"',
  })
  unit_price: string;

  @IsOptional()
  @IsIn(['restock', 'customer_order'])
  purpose?: string;

  @IsOptional()
  @IsString()
  work_order_code?: string;
}

export class CreatePurchaseOrderDto {
  @IsInt32()
  supplier_id: number;

  @IsOptional()
  @IsIn(['MXN', 'USD'])
  currency?: string;

  @IsOptional()
  @IsISO8601()
  expected_at?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => PurchaseOrderLineDto)
  lines: PurchaseOrderLineDto[];
}
