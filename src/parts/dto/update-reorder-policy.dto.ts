import { IsInt, IsOptional, Min, ValidateIf } from 'class-validator';

// `PATCH /parts/{part_id}`: solo la política de reabasto del tipo de pieza. Un campo enviado
// como `null` se limpia (salvo `min_quantity`, que en la base no admite null).
export class UpdateReorderPolicyDto {
  @IsOptional()
  @IsInt()
  @Min(0)
  min_quantity?: number;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @Min(0)
  max_quantity?: number | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @Min(1)
  reorder_quantity?: number | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @Min(0)
  lead_time_days?: number | null;
}

export const REORDER_POLICY_FIELDS = [
  'min_quantity',
  'max_quantity',
  'reorder_quantity',
  'lead_time_days',
] as const;
