import { IsString, IsInt, IsOptional, Min, Max, MaxLength, ValidateIf, IsUUID } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class VariantDto {
  // Present when editing an existing variant; absent for a newly added row.
  @ApiPropertyOptional({ description: 'Existing variant id (omit to create)' })
  @IsOptional()
  @IsUUID()
  id?: string;

  @ApiProperty({ example: 'Кристализиран 500 г' })
  @IsString()
  @MaxLength(120)
  label: string;

  @ApiProperty({ description: 'Variant price in stotinki', example: 650 })
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  priceStotinki: number;

  // Fixed promo price for this variant (stotinki). null = no per-variant promo.
  // Must be below `priceStotinki` (enforced in the service). Setting it on any
  // variant clears the product-level % promo (mutually exclusive).
  @ApiPropertyOptional({ description: 'Fixed promo price in stotinki; null = none', nullable: true })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  salePriceStotinki?: number | null;

  @ApiPropertyOptional({ description: 'NULL = unlimited stock', nullable: true })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  stockQuantity?: number | null;
}
