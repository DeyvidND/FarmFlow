import { IsString, IsIn, IsOptional, IsInt, Min } from 'class-validator';
import { Type } from 'class-transformer';

/** Batch-level defaults posted alongside the uploaded file (multipart fields are strings;
 *  numeric fields are coerced via @Type). */
export class ImportSettingsDto {
  @IsIn(['econt', 'speedy'])
  carrier!: 'econt' | 'speedy';

  @IsIn(['BGN', 'EUR'])
  currency!: 'BGN' | 'EUR';

  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  weightGrams?: number;

  @IsOptional() @IsString()
  contents?: string;

  @IsOptional() @IsIn(['CASH', 'POSTAL_MONEY_TRANSFER'])
  codProcessingType?: 'CASH' | 'POSTAL_MONEY_TRANSFER';

  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  speedyServiceId?: number;
}
