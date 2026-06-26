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
  priceStotinki: number;

  @ApiPropertyOptional({ description: 'NULL = unlimited stock', nullable: true })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  stockQuantity?: number | null;
}
