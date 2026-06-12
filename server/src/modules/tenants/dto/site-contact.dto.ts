import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  MaxLength,
  registerDecorator,
  ValidateIf,
  ValidateNested,
  type ValidationOptions,
} from 'class-validator';

/**
 * A decimal-string coordinate within [min, max], or empty (clears the pin). The
 * previous `@Matches` only bounded digit COUNT, so "99.9"/"999.9" — out of valid
 * lat/lng range — passed and reached the public storefront map. This validates the
 * numeric range, not just the shape.
 */
function IsCoordString(min: number, max: number, opts?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isCoordString',
      target: object.constructor,
      propertyName,
      options: opts,
      validator: {
        validate(value: unknown) {
          if (value === '' || value === undefined || value === null) return true;
          if (typeof value !== 'string' || !/^-?\d+(\.\d+)?$/.test(value)) return false;
          const n = Number(value);
          return Number.isFinite(n) && n >= min && n <= max;
        },
        defaultMessage() {
          return `${propertyName} must be a number between ${min} and ${max}`;
        },
      },
    });
  };
}

/** Known social-network keys the admin dropdown offers. `other` = a free link
 *  with a custom label; the storefront falls back to a globe icon. */
export const SOCIAL_NETWORKS = [
  'fb',
  'ig',
  'yt',
  'tt',
  'viber',
  'telegram',
  'whatsapp',
  'x',
  'other',
] as const;

/** One social link row. `url` must be a real http(s) URL; `network` picks the
 *  icon (optional → older rows / icon guessed from url); `label` is free text
 *  (used for the `other` network). */
export class SocialLinkDto {
  @IsOptional()
  @IsString()
  @IsIn(SOCIAL_NETWORKS)
  network?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  label?: string;

  @IsString()
  @IsUrl({ require_protocol: true })
  @MaxLength(300)
  url!: string;
}

/** One arbitrary labeled contact row ("каквото иска клиента"). `value` is
 *  required free text; `label` is the optional caption shown before it. */
export class CustomFieldDto {
  @IsOptional()
  @IsString()
  @MaxLength(40)
  label?: string;

  @IsString()
  @MaxLength(200)
  value!: string;
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

  // Free-text phone (shown + click-to-call on the storefront). Lenient: digits,
  // spaces, +, and the usual separators. Empty clears it.
  @IsOptional()
  @IsString()
  @MaxLength(40)
  @Matches(/^$|^[+\d][\d\s()\-./]{3,}$/, {
    message: 'phone must be a valid phone number',
  })
  phone?: string;

  @IsOptional()
  @ValidateIf((o) => o.email !== '' && o.email !== undefined && o.email !== null)
  @IsEmail()
  @MaxLength(160)
  email?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(8)
  @ValidateNested({ each: true })
  @Type(() => SocialLinkDto)
  social?: SocialLinkDto[];

  // Arbitrary extra contact rows (label + value). Empty rows are dropped server-side.
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(12)
  @ValidateNested({ each: true })
  @Type(() => CustomFieldDto)
  custom?: CustomFieldDto[];

  // Decimal-string coordinate or empty. Range-checked: lat ∈ [-90, 90], lng ∈ [-180, 180].
  @IsOptional()
  @IsString()
  @IsCoordString(-90, 90)
  mapLat?: string;

  @IsOptional()
  @IsString()
  @IsCoordString(-180, 180)
  mapLng?: string;

  // "#RRGGBB" or empty (empty clears it back to the storefront default).
  @IsOptional()
  @IsString()
  @Matches(/^$|^#[0-9a-fA-F]{6}$/)
  themeColor?: string;
}
