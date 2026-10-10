import { IsInt, Min } from 'class-validator';
import { IsInt32 } from '../../common/validators.js';

export class TransferDto {
  @IsInt32()
  part_id: number;

  @IsInt32()
  from_location_id: number;

  @IsInt32()
  to_location_id: number;

  @IsInt()
  @Min(1)
  quantity: number;
}
