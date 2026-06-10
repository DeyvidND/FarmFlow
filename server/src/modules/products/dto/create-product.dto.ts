import {
  IsString, IsInt, IsOptional, IsBoolean, IsUrl, IsUUID, Min, ValidateIf, ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CoverCropDto } from '../../../common/dto/cover-crop.dto';

export class CreateProductDto {
  @ApiProperty()
  @IsString()
  name: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ description: 'Price in stotinki (integer)', example: 350 })
  @IsInt()
  @Min(0)
  priceStotinki: number;

  @ApiProperty({ example: 'kg' })
  @IsString()
  unit: string;

  @ApiPropertyOptional({ example: '500 г' })
  @IsOptional()
  @IsString()
  weight?: string;

  @ApiPropertyOptional({ example: 'Плодове' })
  @IsOptional()
  @IsString()
  category?: string;

  @ApiPropertyOptional({ example: '#D94A4A', description: 'Hex accent for the thumbnail' })
  @IsOptional()
  @IsString()
  tint?: string;

  @ApiPropertyOptional({ description: 'NULL = unlimited stock' })
  @IsOptional()
  @IsInt()
  @Min(0)
  stockQuantity?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUrl()
  imageUrl?: string;

  // Cover framing (focal point + zoom) for the storefront card. `null` clears it
  // back to centered. The service spreads this straight into the row, so the jsonb
  // column follows it.
  @ApiPropertyOptional({ type: CoverCropDto, nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => CoverCropDto)
  coverCrop?: CoverCropDto | null;

  @ApiPropertyOptional({ description: 'Linked farmer (multi-producer mode); null to unlink' })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  farmerId?: string | null;

  @ApiPropertyOptional({ description: 'Linked subcategory section; null to unlink' })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  subcategoryId?: string | null;
}
