import { IsString, IsOptional, IsEmail, MaxLength, ValidateNested } from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { ApiPropertyOptional, OmitType } from '@nestjs/swagger';
import { LegalDto } from './legal.dto';

/** The legal block minus `confirmedAt`: that is an audit stamp of WHEN the identity
 *  was confirmed, so it is written server-side and never accepted from the client —
 *  same rule the operator's own legal identity follows (`tenants/legal.ts`). */
export class SelfLegalDto extends OmitType(LegalDto, ['confirmedAt'] as const) {}

/** Normalise a blank/whitespace string to undefined so @IsOptional() truly skips it
 *  (class-validator only skips null/undefined) — the repo's ''-vs-undefined gotcha. */
const blankToUndefined = ({ value }: { value: unknown }) =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

/**
 * What a producer sub-account may change about ITSELF (`PATCH /farmers/me`).
 *
 * Deliberately NOT `PartialType(CreateFarmerDto)`: this is the only write path a
 * non-admin has into the `farmers` table, so it is an allow-list, not a subtraction.
 * Commercial terms (commissionRateBps, subscriptionFeeStotinki, payout), operator
 * notes (internalNotes), catalog placement (position, tier, branding, imageUrl) and
 * the display `name` stay operator-owned — a farmer editing their own protocol
 * identity must not be able to rewrite what the operator sells or what they are paid.
 *
 * The fields here are exactly the ones the handover протокол prints for the ПРЕДАЛ
 * party: `legal` (юридическо име / ЕИК / адрес), plus the phone/email contact line.
 */
export class UpdateMyFarmerDto {
  @ApiPropertyOptional({ example: '+359 88 412 0001' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  phone?: string;

  @ApiPropertyOptional({ example: 'petar@ferma.bg' })
  @Transform(blankToUndefined)
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiPropertyOptional({ type: SelfLegalDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => SelfLegalDto)
  legal?: SelfLegalDto;
}
