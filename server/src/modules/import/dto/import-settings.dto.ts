import { IsString, IsIn, IsOptional, IsInt, IsBoolean, Min } from 'class-validator';
import { Type, Transform } from 'class-transformer';

/** Multipart fields arrive as strings ('true'/'false'); coerce to a real boolean.
 *  Anything other than the literal 'false'/'0' counts as true, so an omitted flag
 *  (handled by @IsOptional) keeps the service default of "on". */
const toBool = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? !['false', '0', ''].includes(value.toLowerCase()) : value;

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

  /** Operator-toggled checks (defaults on). When off, the matching pass is skipped:
   *  aiAudit → the OpenAI row review, addressCheck → the address geo/repair pass. */
  @IsOptional() @Transform(toBool) @IsBoolean()
  aiAudit?: boolean;

  @IsOptional() @Transform(toBool) @IsBoolean()
  addressCheck?: boolean;
}
