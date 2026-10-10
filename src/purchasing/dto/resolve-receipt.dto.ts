import { IsOptional } from 'class-validator';
import { IsInt32 } from '../../common/validators.js';

export class ResolveReceiptDto {
  @IsInt32()
  part_id: number;

  // Si falta, la ubicación de recepción U-100.
  @IsOptional()
  @IsInt32()
  location_id?: number;
}
