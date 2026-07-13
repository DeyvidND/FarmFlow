import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Min,
  ValidateNested,
} from 'class-validator';

export class ProtocolItemDto {
  @IsString() productName!: string;
  @IsOptional() @IsString() variantLabel?: string;
  @IsInt() @Min(1) quantity!: number;
  @IsOptional() @IsString() unit?: string;
  @IsInt() @Min(0) priceStotinki!: number;
  @IsOptional() @IsInt() orderNumber?: number;
}

export class CreateProtocolDto {
  @IsIn(['farmer_to_operator', 'operator_to_customer']) kind!: string;
  @IsOptional() @IsUUID() farmerId?: string;
  @IsOptional() @IsUUID() orderId?: string;
  @IsOptional() @IsUUID() slotId?: string;
  @IsArray() @ArrayNotEmpty() @ValidateNested({ each: true }) @Type(() => ProtocolItemDto)
  items!: ProtocolItemDto[];
  @IsOptional() @IsString() fromSignaturePng?: string;
  @IsOptional() @IsString() toSignaturePng?: string;
  @IsOptional() meta?: Record<string, unknown>;
}
