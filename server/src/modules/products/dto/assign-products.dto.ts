import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayNotEmpty, IsArray, IsOptional, IsUUID, ValidateIf } from 'class-validator';

/**
 * Bulk-link products to a farmer and/or a subcategory in one request — powers the
 * "assign products" picker on the Фермери / Подкатегории pages. A `null` target
 * unlinks (sets the column to NULL). Only the keys present are written, so the
 * two associations are independent.
 */
export class AssignProductsDto {
  @ApiProperty({ type: [String], description: 'Product ids to (re)assign' })
  @IsArray()
  @ArrayNotEmpty()
  @IsUUID('4', { each: true })
  productIds!: string[];

  @ApiPropertyOptional({ nullable: true, description: 'Farmer to link, or null to unlink' })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsUUID('4')
  farmerId?: string | null;

  @ApiPropertyOptional({ nullable: true, description: 'Subcategory to link, or null to unlink' })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsUUID('4')
  subcategoryId?: string | null;
}
