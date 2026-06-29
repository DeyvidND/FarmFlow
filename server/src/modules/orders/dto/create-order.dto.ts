import {
  IsArray,
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
  ArrayMinSize,
  ArrayMaxSize,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CreateOrderItemDto } from './create-order-item.dto';

export class CreateOrderDto {
  // Cap the array so an anonymous order can't carry thousands of items (each
  // triggers a product lookup + an order_items row insert) — cheap amplification
  // otherwise, since the only outer bound is the ~100kb JSON body limit.
  @ApiProperty({ type: [CreateOrderItemDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateOrderItemDto)
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  items: CreateOrderItemDto[];

  @ApiPropertyOptional()
  @ValidateIf((o) => o.deliveryType === 'courier')
  @IsString()
  @IsNotEmpty({ message: 'Името е задължително за куриерска доставка' })
  @MaxLength(120)
  customerName?: string;

  @ApiPropertyOptional()
  @ValidateIf((o) => o.deliveryType === 'courier')
  @IsString()
  @IsNotEmpty({ message: 'Телефонът е задължителен за куриерска доставка' })
  @MaxLength(40)
  customerPhone?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsEmail()
  customerEmail?: string;

  @ApiPropertyOptional({ description: 'Chosen delivery slot (if the farm offers delivery)' })
  @IsOptional()
  @IsUUID()
  slotId?: string;

  @ApiPropertyOptional({ enum: ['pickup', 'address', 'econt', 'econt_address', 'courier'], default: 'address' })
  @IsOptional()
  @IsEnum(['pickup', 'address', 'econt', 'econt_address', 'courier'])
  deliveryType?: 'pickup' | 'address' | 'econt' | 'econt_address' | 'courier';

  // Required only for the address-based methods: local farm delivery (`address`)
  // or Econt door delivery (`econt_address`). Market `pickup` and Econt office
  // (`econt`) carry no street address.
  @ApiPropertyOptional({ description: 'Street address (required for address / econt_address)' })
  @ValidateIf((o) => (o.deliveryType ?? 'address') === 'address' || o.deliveryType === 'econt_address' || o.deliveryType === 'courier')
  @IsString()
  @IsNotEmpty({ message: 'Адресът за доставка е задължителен' })
  @MaxLength(300)
  deliveryAddress?: string;

  // Settlement (city/village) for Econt door delivery — the structured city Econt
  // needs to route a waybill. REQUIRED for delivery_type=econt_address (a door
  // label without a structured city is rejected by Econt as ExInvalidCity), so
  // fail fast at checkout rather than after the customer has already ordered.
  @ApiPropertyOptional({ description: 'City/settlement (required for Econt door delivery)' })
  @ValidateIf((o) => o.deliveryType === 'econt_address' || o.deliveryType === 'courier')
  @IsString()
  @IsNotEmpty({ message: 'Населеното място е задължително за доставка до адрес с Еконт' })
  @MaxLength(120)
  deliveryCity?: string;

  // Postal code from the storefront's structured address field. Optional — used
  // only to sharpen geocoding (passed as a `postal_code` component) for local
  // farm delivery; not stored. Absent for free-typed addresses.
  @ApiPropertyOptional({ description: 'Postal code (sharpens geocoding for local delivery)' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  deliveryPostal?: string;

  // Block/entrance/floor/flat (бл./вх./ет./ап.) + courier hint. Stored for display
  // and the farmer's route, but deliberately NOT geocoded — keeping it out of
  // deliveryAddress is the whole point (a hand-typed "бл. 12 вх. А" otherwise makes
  // Google reject the geocode or snap to the wrong point). Local delivery only.
  @ApiPropertyOptional({ description: 'Block/entrance/floor/flat detail (display + route only)' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  deliveryNote?: string;

  // Precise delivery coordinates from the storefront map/autocomplete. Optional:
  // when absent (e.g. free-typed address), the server geocodes deliveryAddress.
  @ApiPropertyOptional({ description: 'Delivery latitude (storefront map pin)' })
  @IsOptional()
  @IsNumber()
  @Min(-90)
  @Max(90)
  deliveryLat?: number;

  @ApiPropertyOptional({ description: 'Delivery longitude (storefront map pin)' })
  @IsOptional()
  @IsNumber()
  @Min(-180)
  @Max(180)
  deliveryLng?: number;

  // Required when delivering to an Econt office.
  @ApiPropertyOptional({ description: 'Еконт office (required when delivery_type=econt)' })
  @ValidateIf((o) => o.deliveryType === 'econt')
  @IsString()
  @IsNotEmpty({ message: 'Изборът на офис на Еконт е задължителен' })
  @MaxLength(200)
  econtOffice?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;

  @ApiPropertyOptional({ enum: ['online', 'cod'], default: 'online' })
  @IsOptional()
  @IsEnum(['online', 'cod'])
  paymentMethod?: 'online' | 'cod';

  // Courier the customer picked in the door-delivery comparison. Only meaningful for
  // delivery_type=econt_address (door); ignored for other modes. Validated against the
  // two carriers we quote.
  @ApiPropertyOptional({ enum: ['econt', 'speedy'] })
  @IsOptional()
  @IsEnum(['econt', 'speedy'])
  carrier?: 'econt' | 'speedy';
}
