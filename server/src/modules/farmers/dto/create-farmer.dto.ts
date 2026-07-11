import {
  IsString, IsOptional, IsInt, IsUrl, IsEmail, Min, Max, MaxLength, ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CoverCropDto } from '../../../common/dto/cover-crop.dto';

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
