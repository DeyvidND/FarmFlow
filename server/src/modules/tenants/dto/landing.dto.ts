import { Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, Max, Min, ValidateNested } from 'class-validator';

/** One landing block as sent by the admin form. Service-side `resolveLanding`
 *  is authoritative (re-clamps); this just rejects gross abuse. */
export class LandingBlockDto {
  @IsOptional()
  @IsBoolean()
  show?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(12)
  count?: number;
}

export class LandingDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => LandingBlockDto)
  categories?: LandingBlockDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => LandingBlockDto)
  farmers?: LandingBlockDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => LandingBlockDto)
  latest?: LandingBlockDto;
}
