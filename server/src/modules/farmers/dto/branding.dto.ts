import { IsString, IsOptional, IsBoolean, IsIn, IsArray, MaxLength, ArrayMaxSize } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Tier-2 „Бранд идентичност" control layer for a farmer's marketplace subpage.
 * Reaches the row through UpdateFarmerDto → farmers.service `.set({ ...dto })` → the
 * `farmers.branding` jsonb column. `enabled` is the paid gate; the PATCH route is
 * admin-only (no @Roles), so a farmer sub-account cannot self-unlock it. Primary color
 * reuses `tint`, portrait reuses `imageUrl`, gallery reuses farmer media — this only
 * carries the extra controls. See docs/tier2-brand-identity-spec.md.
 */
export class BrandingDto {
  @ApiPropertyOptional({ description: 'Paid gate — when true the branded subpage renders.' })
  @IsBoolean()
  enabled: boolean;

  @ApiPropertyOptional({ enum: ['tier2'] })
  @IsOptional()
  @IsIn(['tier2'])
  plan?: 'tier2';

  @ApiPropertyOptional({ example: '#E7A33E', description: 'Secondary/accent color (hex).' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  accent?: string;

  @ApiPropertyOptional({ example: 'lora' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  headingFont?: string;

  @ApiPropertyOptional({ enum: ['wide', 'mosaic', 'row', 'grid'] })
  @IsOptional()
  @IsIn(['wide', 'mosaic', 'row', 'grid'])
  gallery?: 'wide' | 'mosaic' | 'row' | 'grid';

  @ApiPropertyOptional({ type: [String], example: ['verified', 'bio'] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(8)
  @IsString({ each: true })
  @MaxLength(40, { each: true })
  badges?: string[];

  @ApiPropertyOptional({ description: 'ISO — when the operator unlocked it.' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  unlockedAt?: string;

  @ApiPropertyOptional({ description: 'Admin user id who unlocked it (attribution).' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  unlockedBy?: string;
}
