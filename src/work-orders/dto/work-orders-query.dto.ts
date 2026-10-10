import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';

export const STAGES = [
  'awaiting_quick_inspection',
  'quick_inspection',
  'awaiting_full_inspection',
  'full_inspection',
  'cleaning',
  'assembly',
  'run_in',
  'final_assembly',
  'final_release',
] as const;

export const DEPARTMENTS = [
  'spindles',
  'motors',
  'electronics',
  'torque_center',
] as const;

export class WorkOrdersQueryDto {
  @IsOptional()
  @IsIn(STAGES)
  stage?: string;

  @IsOptional()
  @IsIn(DEPARTMENTS)
  department?: string;

  // Por defecto solo las órdenes vivas; `deleted=true` para ver las dadas de baja.
  @IsOptional()
  @Transform(({ value }) =>
    value === 'true' ? true : value === 'false' ? false : value,
  )
  @IsBoolean()
  deleted?: boolean;

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
