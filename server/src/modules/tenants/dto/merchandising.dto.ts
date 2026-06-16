import { Type } from 'class-transformer';
import { IsBoolean, IsOptional, ValidateNested } from 'class-validator';

/** One merchandising feature toggle as sent by the admin form. Service-side
 *  `resolveMerchandising` is authoritative (re-clamps); this just rejects abuse. */
export class MerchandisingBlockDto {
  @IsOptional()
  @IsBoolean()
  show?: boolean;
}

export class MerchandisingDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => MerchandisingBlockDto)
  bestSellers?: MerchandisingBlockDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => MerchandisingBlockDto)
  recommendations?: MerchandisingBlockDto;
}
