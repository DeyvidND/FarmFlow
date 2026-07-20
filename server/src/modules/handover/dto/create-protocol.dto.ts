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
  // `string | null` (not just optional): the key being ABSENT means "omitted, fall
  // back to the saved signature" (one-tap flow); an explicit `null` means the party
  // deliberately gave no signature and must NOT be auto-filled. See createSigned.
  // `@IsOptional()` skips IsString for both `null` and `undefined` (class-validator
  // treats missing-or-null the same for validation purposes), so this still rejects
  // any other non-string value.
  @IsOptional() @IsString() fromSignaturePng?: string | null;
  @IsOptional() @IsString() toSignaturePng?: string | null;
  @IsOptional() meta?: Record<string, unknown>;
}
