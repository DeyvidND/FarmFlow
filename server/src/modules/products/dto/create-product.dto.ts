import { IsString, IsInt, IsOptional, IsBoolean, IsUrl, IsUUID, Min, ValidateIf } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

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
