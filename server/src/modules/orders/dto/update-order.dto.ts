import {
  IsArray,
  IsEmail,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
  ArrayMinSize,
  ArrayMaxSize,
  ValidateIf,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { CreateOrderItemDto } from './create-order-item.dto';

/**
 * Owner-side full order edit (PATCH /orders/:id). Every field is optional — a
 * partial patch. `items`, when present, is a FULL replacement of the order's
 * lines (min 1). `slotId: null` clears the slot; a uuid reassigns it. Delivery
 * *method* is intentionally NOT editable here.
 */
export class UpdateOrderDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  customerName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(40)
  customerPhone?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsEmail()
  customerEmail?: string | null;

  @ApiPropertyOptional({ description: 'Street address (local / Econt-door / courier).' })
  @IsOptional()
  @IsString()
  @MaxLength(240)
  deliveryAddress?: string;

  @ApiPropertyOptional({ description: 'Block/entrance/floor/flat detail (бл./вх.).' })
  @IsOptional()
  @IsString()
  @MaxLength(240)
  deliveryNote?: string | null;

  @ApiPropertyOptional({ description: 'Econt office display string (econt type).' })
  @IsOptional()
  @IsString()
  @MaxLength(240)
  econtOffice?: string;

  @ApiPropertyOptional({ description: 'Reassign (uuid) or clear (null) the delivery slot.' })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  slotId?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string | null;

  @ApiPropertyOptional({ type: [CreateOrderItemDto], description: 'Full replacement of the order lines (min 1).' })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateOrderItemDto)
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  items?: CreateOrderItemDto[];
}
