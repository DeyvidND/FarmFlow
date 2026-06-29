import {
  IsString, IsOptional, IsInt, IsUrl, IsEmail, Min, MaxLength, ValidateNested, IsBoolean,
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

  // Per-farmer courier opt-in (migration 0069). Vasil toggles it from "Фермери";
  // settable on create or update. Inherited as optional by UpdateFarmerDto.
  @ApiPropertyOptional({ description: 'Enable/disable courier delivery for this farmer' })
  @IsOptional()
  @IsBoolean()
  courierEnabled?: boolean;
}
