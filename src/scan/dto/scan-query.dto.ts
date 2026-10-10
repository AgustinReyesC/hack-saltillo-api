import { IsString, MaxLength, MinLength } from 'class-validator';

export class ScanQueryDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  code: string;
}
