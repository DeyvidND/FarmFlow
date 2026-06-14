import { IsOptional, IsString, MaxLength } from 'class-validator';

/** Editable storefront tracking IDs (settings.marketing). All optional — the
 *  admin form sends the whole block on save; an empty string clears that vendor.
 *  Strict per-vendor format validation lives in `normalizeMarketing`
 *  (drop-if-invalid), so the DTO only bounds type + length here. A
 *  malformed-but-typed value is tolerated at the DTO layer and silently dropped
 *  server-side rather than 400'd, matching the lenient contact-block pattern. */
export class SiteMarketingDto {
  @IsOptional()
  @IsString()
  @MaxLength(40)
  ga4?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  googleAds?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  googleAdsLabel?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  metaPixel?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  gtm?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  tiktok?: string;
}
