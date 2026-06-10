import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEmail,
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
