import { IsString, IsNotEmpty, IsIn, IsOptional, IsInt, Min, MaxLength, ValidateIf } from 'class-validator';

/** Courier-neutral shipment to price across all carriers. */
export class CompareShipmentDto {
  // Required unless a raw destinationAddress is supplied (the public storefront's
  // typed-address path, no Google pick). The admin panel always sends this directly.
  @ValidateIf((o: CompareShipmentDto) => !o.destinationAddress)
  @IsString() @IsNotEmpty() @MaxLength(120)
  destinationCity?: string;

  // Public storefront typed-address path: raw address text the backend geocodes to a
  // settlement server-side (see PublicShippingQuoteController) — no Google pick needed.
  @ValidateIf((o: CompareShipmentDto) => !o.destinationCity)
  @IsString() @IsNotEmpty() @MaxLength(250)
  destinationAddress?: string;

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
