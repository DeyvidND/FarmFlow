import { IsString, IsOptional, IsIn, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Operator legal identity — the marketplace operator's own registration details,
 * shown as the „Приел"/„Предал" party on приемо-предавателни протоколи and delivery
 * receipts (see handover-protocol feature, `requireLegal`). Mirrors the shape of
 * `farmers/dto/legal.dto.ts` (the seller-side identity) but is a SEPARATE DTO — the
 * two are different bounded resources even though the fields match today.
 */
export class LegalDto {
  @ApiPropertyOptional({ enum: ['individual', 'sole_trader', 'company'] })
  @IsOptional()
  @IsIn(['individual', 'sole_trader', 'company'])
  kind?: 'individual' | 'sole_trader' | 'company';

  @ApiPropertyOptional({ example: 'ЕТ „ФермериБГ"', description: 'Юридическо/фирмено име на оператора.' })
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

  @ApiPropertyOptional({ example: '123456789', description: 'Рег. номер (ако операторът е физическо лице).' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  regNo?: string;
}
