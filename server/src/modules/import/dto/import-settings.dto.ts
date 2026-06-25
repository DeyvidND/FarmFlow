import { IsString, IsIn, IsOptional, IsInt, Min } from 'class-validator';
import { Type } from 'class-transformer';

/** Batch-level defaults posted alongside the uploaded file (multipart fields are strings;
 *  numeric fields are coerced via @Type).
 *
 *  carrier/currency are optional: the operator uploads just the file and the courier is
 *  chosen per-row later via the cheapest-quote step. Defaults applied in the service:
 *  carrier='econt' (a safe parse base; overridden per row), currency='EUR'. */
export class ImportSettingsDto {
  @IsOptional() @IsIn(['econt', 'speedy'])
  carrier?: 'econt' | 'speedy';

  @IsOptional() @IsIn(['BGN', 'EUR'])
  currency?: 'BGN' | 'EUR';

  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  weightGrams?: number;

  @IsOptional() @IsString()
  contents?: string;

  @IsOptional() @IsIn(['CASH', 'POSTAL_MONEY_TRANSFER'])
  codProcessingType?: 'CASH' | 'POSTAL_MONEY_TRANSFER';

  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  speedyServiceId?: number;
}
