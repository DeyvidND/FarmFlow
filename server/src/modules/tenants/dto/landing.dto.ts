import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsUUID,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

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

/** Reviews block: show flag + the farmer's picked review ids (uuids). Service-side
 *  `resolveLanding` re-clamps (dedupe, cap 12); this rejects gross abuse. */
export class LandingReviewsDto {
  @IsOptional()
  @IsBoolean()
  show?: boolean;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(12)
  @IsUUID('all', { each: true })
  ids?: string[];
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

  @IsOptional()
  @ValidateNested()
  @Type(() => LandingReviewsDto)
  reviews?: LandingReviewsDto;
}
