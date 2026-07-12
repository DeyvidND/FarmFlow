import { IsEmail, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

/** One-shot producer onboarding: create + optional AI catalog + optional invite.
 *  The price list photo arrives as the multipart `file` part, not in this DTO. */
export class OnboardProducerDto {
  @IsString()
  @IsNotEmpty({ message: 'Името на производителя е задължително.' })
  @MaxLength(200)
  name!: string;

  @IsOptional() @IsString() @MaxLength(50)
  phone?: string;

  @IsOptional() @IsEmail({}, { message: 'Невалиден имейл.' })
  email?: string;

  @IsOptional() @IsString() @MaxLength(100_000)
  pricelistText?: string;
}
