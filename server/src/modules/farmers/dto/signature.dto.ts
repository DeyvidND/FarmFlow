import { IsOptional, IsString, MaxLength } from 'class-validator';

/** A reusable party signature as a PNG data-URL, or null to clear it. Capped so a
 *  runaway canvas export can't bloat a row (~200KB is plenty for a signature). */
export class SignatureDto {
  @IsOptional()
  @IsString()
  @MaxLength(300_000)
  signaturePng?: string | null;
}
