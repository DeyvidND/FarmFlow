import { IsString, IsOptional, IsIn, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Legal seller identity for the farmer-as-seller marketplace — the producer is the
 * legal Продавач, so КЗП requires the buyer be shown who they contract with and НАП
 * needs the seller's identity. Reaches the row through Create/UpdateFarmerDto →
 * farmers.service `.set({ ...dto })` → the `farmers.legal` jsonb column, and IS exposed
 * on the public farmer projection (this is required seller disclosure, not owner-only
 * finance). Every field is optional so onboarding can be gradual; the final required
 * set is confirmed with the юрист/счетоводител before a farmer is flipped to a live
 * seller. `kind` selects which id applies: individual → `regNo` (регистриран земеделски
 * производител), sole_trader (ЕТ) → `eik`, company (ЕООД/ООД/АД) → `eik` (+ optional
 * `vatNumber`).
 */
export class LegalDto {
  @ApiPropertyOptional({ enum: ['individual', 'sole_trader', 'company'] })
  @IsOptional()
  @IsIn(['individual', 'sole_trader', 'company'])
  kind?: 'individual' | 'sole_trader' | 'company';

  @ApiPropertyOptional({ example: 'ЕТ „Димка Четова"', description: 'Юридическо/фирмено име на продавача.' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @ApiPropertyOptional({ example: '203912345', description: 'ЕИК/БУЛСТАТ (ЕТ/фирма).' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  eik?: string;

  @ApiPropertyOptional({ example: 'BG203912345', description: 'ДДС номер (ако е регистриран по ЗДДС).' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  vatNumber?: string;

  @ApiPropertyOptional({ example: 'гр. Варна, ул. „Приморска" 12', description: 'Адрес на управление/седалище.' })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  address?: string;

  @ApiPropertyOptional({ example: '123456789', description: 'Рег. номер земеделски производител (Наредба 3).' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  regNo?: string;

  @ApiPropertyOptional({ description: 'ISO — кога данните са потвърдени (одит следа).' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  confirmedAt?: string;
}
