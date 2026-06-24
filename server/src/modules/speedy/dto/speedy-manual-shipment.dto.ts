import {
  IsString, IsNotEmpty, IsIn, IsOptional, IsInt, Min, IsBoolean, MaxLength,
} from 'class-validator';

/** A Speedy shipment typed in by hand in the standalone app (no storefront order).
 *  Speedy addresses are id-based: siteId (нас. място) + streetId/streetNo for a door,
 *  or officeId for an office. serviceId is the Speedy courier-service code. */
export class SpeedyManualShipmentDto {
  @IsString() @IsNotEmpty() @MaxLength(120)
  receiverName!: string;

  @IsString() @IsNotEmpty() @MaxLength(40)
  receiverPhone!: string;

  @IsIn(['office', 'address'])
  deliveryMode!: 'office' | 'address';

  // Required when deliveryMode === 'office'.
  @IsOptional() @IsInt() @Min(1)
  officeId?: number;

  // Required when deliveryMode === 'address'.
  @IsOptional() @IsInt() @Min(1)
  siteId?: number;
  @IsOptional() @IsInt() @Min(1)
  streetId?: number;
  @IsOptional() @IsString() @MaxLength(20)
  streetNo?: string;
  @IsOptional() @IsString() @MaxLength(20)
  blockNo?: string;
  @IsOptional() @IsString() @MaxLength(20)
  entranceNo?: string;
  @IsOptional() @IsString() @MaxLength(20)
  floorNo?: string;
  @IsOptional() @IsString() @MaxLength(20)
  apartmentNo?: string;

  // Speedy courier-service code (e.g. 505). Required to create a shipment.
  @IsInt() @Min(1)
  serviceId!: number;

  @IsOptional() @IsInt() @Min(0)
  weightGrams?: number; // grams in the API; converted to kg for Speedy

  @IsOptional() @IsInt() @Min(1)
  parcelsCount?: number;

  @IsOptional() @IsString() @MaxLength(120)
  contents?: string;

  // 0 / omitted → no cash-on-delivery.
  @IsOptional() @IsInt() @Min(0)
  codAmountStotinki?: number;

  @IsOptional() @IsInt() @Min(0)
  declaredValueStotinki?: number;
}
