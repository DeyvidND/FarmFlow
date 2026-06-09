import {
  IsBoolean,
  IsEmail,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Max,
  Min,
  MinLength,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

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
  delivery?: Record<string, unknown>;
}
