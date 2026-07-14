import { IsString, IsOptional, MaxLength, Matches } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Payout account for marketplace settlement — where the farmer's turnover is
 * transferred. Reaches the row through Create/UpdateFarmerDto → farmers.service
 * `.set({ ...dto })` → the `farmers.payout` jsonb column. OPERATOR-ONLY: never
 * added to the public farmer projection (unlike `legal`). Capture-only for now —
 * no payout execution. Every field is optional so it can be filled gradually.
 */
export class PayoutDto {
  @ApiPropertyOptional({ example: 'BG80BNBG96611020345678', description: 'IBAN за изплащане на оборота.' })
  @IsOptional()
  // Empty string → undefined so a blank field doesn't trip @Matches (the '' gotcha).
  @Transform(({ value }) => (value === '' ? undefined : value))
  @IsString()
  @MaxLength(34)
  // Loose BG-IBAN shape (BGkk BANK dddddd cccccccc = 22 chars); still optional so blanks pass.
  @Matches(/^BG\d{2}[A-Z]{4}\d{6}[A-Z0-9]{8}$/i, { message: 'Невалиден IBAN (очаква се български IBAN).' })
  iban?: string;

  @ApiPropertyOptional({ example: 'Петър Петров', description: 'Титуляр на сметката.' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  holder?: string;

  @ApiPropertyOptional({ example: 'BNBGBGSF', description: 'BIC/SWIFT (по избор).' })
  @IsOptional()
  @IsString()
  @MaxLength(11)
  bic?: string;
}
