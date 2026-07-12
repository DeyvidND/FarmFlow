import {
  IsString, IsOptional, IsInt, IsUrl, IsEmail, Min, Max, MaxLength, ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CoverCropDto } from '../../../common/dto/cover-crop.dto';
import { BrandingDto } from './branding.dto';
import { LegalDto } from './legal.dto';

export class CreateFarmerDto {
  @ApiProperty()
  @IsString()
  @MaxLength(200)
  name: string;

  @ApiPropertyOptional({ example: 'Пчелар — мед' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  role?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  bio?: string;

  @ApiPropertyOptional({ example: '+359 88 412 0001' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  phone?: string;

  @ApiPropertyOptional({ example: 'petar@ferma.bg' })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiPropertyOptional({ example: '2014' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  since?: string;

  @ApiPropertyOptional({ example: 'Варна' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  city?: string;

  @ApiPropertyOptional({ example: '#2C5530' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  tint?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUrl()
  imageUrl?: string;

  // Cover framing (focal point + zoom). `null` clears it back to centered. The
  // service spreads this straight into the row, so the jsonb column follows it.
  @ApiPropertyOptional({ type: CoverCropDto, nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => CoverCropDto)
  coverCrop?: CoverCropDto | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  position?: number;

  /** Marketplace ranking tier: 1 = Базов, 2 = Бранд идентичност, 3 = Собствен сайт.
   *  Operator-set. When omitted, the service keeps the current tier (auto-bumped
   *  to >=2 if branding is enabled). */
  @ApiPropertyOptional({ minimum: 1, maximum: 3 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(3)
  tier?: number;

  // Tier-2 branding control layer. The service spreads this straight into the row,
  // so the `branding` jsonb column follows it. Admin-only route (no @Roles on PATCH).
  @ApiPropertyOptional({ type: BrandingDto, nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => BrandingDto)
  branding?: BrandingDto | null;

  // Legal seller identity (КЗП/НАП disclosure). The service spreads this straight into
  // the row, so the `farmers.legal` jsonb column follows it. `null` clears it.
  @ApiPropertyOptional({ type: LegalDto, nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => LegalDto)
  legal?: LegalDto | null;

  /** Комисиона override в базисни точки (500 = 5%). NULL = наследява настройката на фермата. */
  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10000)
  commissionRateBps?: number | null;

  /** Месечна такса override в стотинки/евроценти (1200 = 12 €). NULL = наследява настройката. */
  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsInt()
  @Min(0)
  subscriptionFeeStotinki?: number | null;
}
