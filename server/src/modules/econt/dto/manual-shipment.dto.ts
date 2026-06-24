import {
  IsString, IsNotEmpty, IsIn, IsOptional, IsInt, Min, IsBoolean, MaxLength,
} from 'class-validator';

/** A shipment typed in by hand in the standalone app (no storefront order). */
export class ManualShipmentDto {
  @IsString() @IsNotEmpty() @MaxLength(120)
  receiverName!: string;

  @IsString() @IsNotEmpty() @MaxLength(40)
  receiverPhone!: string;

  @IsIn(['office', 'address'])
  deliveryMode!: 'office' | 'address';

  // Required when deliveryMode === 'office'.
  @IsOptional() @IsString() @MaxLength(20)
  receiverOfficeCode?: string;

  // Required when deliveryMode === 'address'.
  @IsOptional() @IsString() @MaxLength(120)
  receiverCity?: string;
  @IsOptional() @IsString() @MaxLength(240)
  receiverAddress?: string;

  @IsOptional() @IsInt() @Min(0)
  weightGrams?: number; // grams in the API; converted to kg for the label

  @IsOptional() @IsString() @MaxLength(120)
  contents?: string;

  // 0 / omitted → no cash-on-delivery.
  @IsOptional() @IsInt() @Min(0)
  codAmountStotinki?: number;

  @IsOptional() @IsBoolean() smsNotification?: boolean;
  @IsOptional() @IsBoolean() refrigerated?: boolean;
  @IsOptional() @IsInt() @Min(0) declaredValueStotinki?: number;
}
