import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
  MinLength,
  registerDecorator,
  ValidateIf,
  type ValidationOptions,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Cap the serialized size of a free-form jsonb blob. `settings.delivery` /
 * `settings.routing` accept a client-owned shape (validated only as an object),
 * so without a ceiling an authenticated admin could persist a multi-MB blob that
 * bloats the row and every cached TenantMeta payload. 20 KB is ample headroom.
 */
function MaxJsonSize(maxBytes: number, opts?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'maxJsonSize',
      target: object.constructor,
      propertyName,
      options: opts,
      validator: {
        validate(value: unknown) {
          if (value === undefined || value === null) return true;
          try {
            return Buffer.byteLength(JSON.stringify(value), 'utf8') <= maxBytes;
          } catch {
            return false; // unserializable (e.g. circular) → reject
          }
        },
        defaultMessage() {
          return `${propertyName} is too large (max ${maxBytes} bytes)`;
        },
      },
    });
  };
}

export class UpdateTenantDto {
  @ApiPropertyOptional({ example: 'Ферма Петрови' })
  @IsOptional()
  @IsString()
  @MinLength(2)
  name?: string;

  @ApiPropertyOptional({ example: '+359 88 123 4567' })
  @IsOptional()
  @IsString()
  phone?: string;

  @ApiPropertyOptional({ example: 'ivan@ferma-petrovi.bg' })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiPropertyOptional({ example: true, description: 'Farmer offers self-delivery (shows slots on storefront)' })
  @IsOptional()
  @IsBoolean()
  deliveryEnabled?: boolean;

  @ApiPropertyOptional({ example: false, description: 'Multiple producers share this storefront' })
  @IsOptional()
  @IsBoolean()
  multiFarmer?: boolean;

  @ApiPropertyOptional({ example: false, description: 'Group products into subcategory sections' })
  @IsOptional()
  @IsBoolean()
  multiSubcat?: boolean;

  @ApiPropertyOptional({ example: true, description: 'Show the articles section on the storefront' })
  @IsOptional()
  @IsBoolean()
  articlesEnabled?: boolean;

  @ApiPropertyOptional({ example: true, description: 'Show the reviews section on the storefront' })
  @IsOptional()
  @IsBoolean()
  reviewsEnabled?: boolean;

  @ApiPropertyOptional({ description: 'Storefront title for the availability section (null → default)' })
  @IsOptional()
  @IsString()
  availabilityTitle?: string | null;

  @ApiPropertyOptional({ example: false, description: 'Show the «Продукт на седмицата» highlight' })
  @IsOptional()
  @IsBoolean()
  productOfWeekEnabled?: boolean;

  @ApiPropertyOptional({
    enum: ['manual', 'auto'],
    description: 'manual = pick a product; auto = weekly ISO-week rotation',
  })
  @IsOptional()
  @IsIn(['manual', 'auto'])
  productOfWeekMode?: 'manual' | 'auto';

  @ApiPropertyOptional({ description: 'Featured product id (manual mode); null to clear' })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsUUID()
  productOfWeekId?: string | null;

  @ApiPropertyOptional({ description: 'Optional blurb shown with the featured product' })
  @IsOptional()
  @IsString()
  productOfWeekNote?: string | null;

  @ApiPropertyOptional({
    enum: ['section', 'bar'],
    description: 'Where the highlight renders: full section under the hero, or a thin bar above the header',
  })
  @IsOptional()
  @IsIn(['section', 'bar'])
  productOfWeekPlacement?: 'section' | 'bar';

  // Home / depot — the delivery route origin. If an address is given without
  // coords, the server geocodes it on save.
  @ApiPropertyOptional({ example: 'с. Звездица, общ. Варна' })
  @IsOptional()
  @IsString()
  farmAddress?: string;

  @ApiPropertyOptional({ description: 'Home latitude (map pin)' })
  @IsOptional()
  @IsNumber()
  @Min(-90)
  @Max(90)
  farmLat?: number;

  @ApiPropertyOptional({ description: 'Home longitude (map pin)' })
  @IsOptional()
  @IsNumber()
  @Min(-180)
  @Max(180)
  farmLng?: number;

  /**
   * Route-end config, persisted to `settings.routing`:
   * `{ endMode: 'home' | 'last' | 'custom', endAddress?: string }`.
   * A custom `endAddress` is geocoded on save into endLat/endLng.
   */
  @ApiPropertyOptional({ description: 'Route end config (persisted to settings.routing)' })
  @IsOptional()
  @IsObject()
  @MaxJsonSize(20_000)
  routing?: Record<string, unknown>;

  /**
   * Per-tenant delivery configuration blob (methods, schedule, pricing, Econt
   * settings). Stored as-is under `settings.delivery` jsonb. Validated only as a
   * plain object — its inner shape is owned by the client. The Econt API password
   * is intentionally NOT part of this blob (never persisted until a live Econt
   * integration exists); only `econt.configured` / `econt.username` are kept.
   */
  @ApiPropertyOptional({ description: 'Delivery config (persisted to settings.delivery)' })
  @IsOptional()
  @IsObject()
  @MaxJsonSize(20_000)
  delivery?: Record<string, unknown>;
}
