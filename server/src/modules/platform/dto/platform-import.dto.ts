import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsOptional, IsString, ValidateNested } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { CreateProductDto } from '../../products/dto/create-product.dto';
import { CreateFarmerDto } from '../../farmers/dto/create-farmer.dto';
import { CreateSubcategoryDto } from '../../subcategories/dto/create-subcategory.dto';
import { SiteContactDto } from '../../tenants/dto/site-contact.dto';

/**
 * Super-admin bulk seed for a tenant during onboarding. Each section is optional;
 * rows reuse the same validated DTOs the tenant-facing create endpoints use, so a
 * malformed import row is rejected the same way a manual create would be. Runs as
 * the operator (platform token), so it bypasses the new tenant's mustChangePassword
 * lock — which blocks every owner-side write until the farmer sets their password.
 */
export class PlatformImportDto {
  @ApiPropertyOptional({ type: [CreateProductDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(1000)
  @ValidateNested({ each: true })
  @Type(() => CreateProductDto)
  products?: CreateProductDto[];

  @ApiPropertyOptional({ type: [CreateFarmerDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => CreateFarmerDto)
  farmers?: CreateFarmerDto[];

  @ApiPropertyOptional({ type: [CreateSubcategoryDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => CreateSubcategoryDto)
  categories?: CreateSubcategoryDto[];

  @ApiPropertyOptional({ type: SiteContactDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => SiteContactDto)
  contact?: SiteContactDto;

  /** Base64-encoded PNG/ICO favicon (e.g. generated from the farm's logo). */
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  faviconBase64?: string;
}
