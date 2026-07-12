import { IsEmail, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';

// The onboarding form posts multipart/form-data — every untouched optional text
// field arrives as '', not absent. @IsOptional() alone skips only null/undefined,
// so a bare '' reached @IsEmail() and 400'd a field advertised as optional.
// Normalise blank (or whitespace-only) → undefined so it's truly skipped.
const blankToUndefined = ({ value }: { value: unknown }) =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

/** One-shot producer onboarding: create + optional AI catalog + optional invite.
 *  The price list photo arrives as the multipart `file` part, not in this DTO. */
export class OnboardProducerDto {
  @IsString()
  @IsNotEmpty({ message: 'Името на производителя е задължително.' })
  @MaxLength(200)
  name!: string;

  @Transform(blankToUndefined)
  @IsOptional() @IsString() @MaxLength(50)
  phone?: string;

  @Transform(blankToUndefined)
  @IsOptional() @IsEmail({}, { message: 'Невалиден имейл.' })
  email?: string;

  @Transform(blankToUndefined)
  @IsOptional() @IsString() @MaxLength(100_000)
  pricelistText?: string;
}
