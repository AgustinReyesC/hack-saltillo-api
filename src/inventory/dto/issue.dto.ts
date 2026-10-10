import { IsInt, IsNotEmpty, IsString, Min } from 'class-validator';
import { IsInt32, IsIntOrNonEmptyString } from '../../common/validators.js';

export class IssueDto {
  @IsString()
  @IsNotEmpty()
  work_order_code: string;

  @IsInt32()
  part_id: number;

  @IsInt32()
  location_id: number;

  @IsInt()
  @Min(1)
  quantity: number;

  @IsIntOrNonEmptyString()
  issued_by: number | string;
}
