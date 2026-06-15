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
  Min,
  ValidateIf,
  ValidateNested,
  ArrayMinSize,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CreateOrderItemDto } from './create-order-item.dto';

export class CreateOrderDto {
  @ApiProperty({ type: [CreateOrderItemDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateOrderItemDto)
  @ArrayMinSize(1)
  items: CreateOrderItemDto[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  customerName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  customerPhone?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsEmail()
  customerEmail?: string;

  @ApiPropertyOptional({ description: 'Chosen delivery slot (if the farm offers delivery)' })
  @IsOptional()
  @IsUUID()
  slotId?: string;

  @ApiPropertyOptional({ enum: ['pickup', 'address', 'econt', 'econt_address'], default: 'address' })
  @IsOptional()
  @IsEnum(['pickup', 'address', 'econt', 'econt_address'])
  deliveryType?: 'pickup' | 'address' | 'econt' | 'econt_address';

  // Required only for the address-based methods: local farm delivery (`address`)
  // or Econt door delivery (`econt_address`). Market `pickup` and Econt office
  // (`econt`) carry no street address.
  @ApiPropertyOptional({ description: 'Street address (required for address / econt_address)' })
  @ValidateIf((o) => (o.deliveryType ?? 'address') === 'address' || o.deliveryType === 'econt_address')
  @IsString()
  @IsNotEmpty({ message: 'Адресът за доставка е задължителен' })
  deliveryAddress?: string;

  // Settlement (city/village) for Econt door delivery — the structured city Econt
  // needs to route a waybill. REQUIRED for delivery_type=econt_address (a door
  // label without a structured city is rejected by Econt as ExInvalidCity), so
  // fail fast at checkout rather than after the customer has already ordered.
  @ApiPropertyOptional({ description: 'City/settlement (required for Econt door delivery)' })
  @ValidateIf((o) => o.deliveryType === 'econt_address')
  @IsString()
  @IsNotEmpty({ message: 'Населеното място е задължително за доставка до адрес с Еконт' })
  deliveryCity?: string;

  // Postal code from the storefront's structured address field. Optional — used
  // only to sharpen geocoding (passed as a `postal_code` component) for local
  // farm delivery; not stored. Absent for free-typed addresses.
  @ApiPropertyOptional({ description: 'Postal code (sharpens geocoding for local delivery)' })
  @IsOptional()
  @IsString()
  deliveryPostal?: string;

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
  econtOffice?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;

  @ApiPropertyOptional({ enum: ['online', 'cod'], default: 'online' })
  @IsOptional()
  @IsEnum(['online', 'cod'])
  paymentMethod?: 'online' | 'cod';
}
