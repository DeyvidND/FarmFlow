import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';

/** One social link row. `url` must be a real http(s) URL; `label` is free text. */
export class SocialLinkDto {
  @IsOptional()
  @IsString()
  @MaxLength(40)
  label?: string;

  @IsString()
  @IsUrl({ require_protocol: true })
  @MaxLength(300)
  url!: string;
}

/** Editable storefront contact block (settings.contact) + theme color
 *  (settings.brand.themeColor). All optional — the admin form sends the whole
 *  block on save, but partials are tolerated. Empty strings are allowed (they
 *  clear the value). */
export class SiteContactDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  address?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  hours?: string;

  @IsOptional()
  @IsString()
  @MaxLength(400)
  tagline?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(8)
  @ValidateNested({ each: true })
  @Type(() => SocialLinkDto)
  social?: SocialLinkDto[];

  // Decimal or empty. Lat ±90, lng ±180 — kept loose (string passthrough).
  @IsOptional()
  @IsString()
  @Matches(/^$|^-?\d{1,2}(\.\d+)?$/)
  mapLat?: string;

  @IsOptional()
  @IsString()
  @Matches(/^$|^-?\d{1,3}(\.\d+)?$/)
  mapLng?: string;

  // "#RRGGBB" or empty (empty clears it back to the storefront default).
  @IsOptional()
  @IsString()
  @Matches(/^$|^#[0-9a-fA-F]{6}$/)
  themeColor?: string;
}
