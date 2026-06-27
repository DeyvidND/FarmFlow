import { IsString, IsNotEmpty, IsIn, IsOptional, IsInt, Min, MaxLength } from 'class-validator';

/** Courier-neutral shipment to price across all carriers. */
export class CompareShipmentDto {
  @IsString() @IsNotEmpty() @MaxLength(120)
  destinationCity!: string;

  // Collected for the create-handoff after the producer picks a carrier; v1
  // prices at city level and does not differentiate office vs door.
  @IsIn(['office', 'address'])
  deliveryMode!: 'office' | 'address';

  @IsOptional() @IsInt() @Min(0)
  weightGrams?: number;

  // When the customer chose наложен платеж, the quote must include the COD surcharge
  // so the cheaper carrier is honest. Optional; absent/0 = base price compare.
  @IsOptional() @IsInt() @Min(0)
  codAmountStotinki?: number;
}
