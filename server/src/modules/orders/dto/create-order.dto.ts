import {
  IsArray,
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
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

  @ApiPropertyOptional({ enum: ['address', 'econt'], default: 'address' })
  @IsOptional()
  @IsEnum(['address', 'econt'])
  deliveryType?: 'address' | 'econt';

  // Required when delivering to an address (the default when deliveryType is omitted).
  @ApiPropertyOptional({ description: 'Street address (required when delivery_type=address)' })
  @ValidateIf((o) => (o.deliveryType ?? 'address') === 'address')
  @IsString()
  @IsNotEmpty({ message: 'Адресът за доставка е задължителен' })
  deliveryAddress?: string;

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
}
