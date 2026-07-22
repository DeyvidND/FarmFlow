import { IsIn, IsInt, IsOptional, IsString, Matches, Min } from 'class-validator';
import { Transform } from 'class-transformer';

export class ConsolidatedEnsureDto {
  @IsString() @Matches(/^\d{4}-\d{2}-\d{2}$/) date!: string;
  @IsIn(['day', 'leg']) scope!: 'day' | 'leg';
  @Transform(({ value }) => (value === '' || value === undefined ? undefined : Number(value)))
  @IsOptional() @IsInt() @Min(0) legIndex?: number;
}
