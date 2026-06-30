import { IsBoolean, IsInt, IsNumber, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/**
 * Optional per-shipment overrides the farmer can set when turning a courier DRAFT
 * into a real waybill. Every field is optional — anything left out falls back to the
 * farm's package defaults (so the simple "just create it" flow keeps working).
 */
export class FinalizeDraftDto {
  /** Real parcel weight in kg — drives the courier price. Omit → farm default (or 1kg). */
  @IsOptional() @IsNumber() @Min(0.01) @Max(1000) weightKg?: number;

  /** What's inside (e.g. „мед, 3 буркана") — printed on the waybill. Omit → farm default. */
  @IsOptional() @IsString() @MaxLength(100) contents?: string;

  /** How many separate boxes this shipment is. Omit → 1. */
  @IsOptional() @IsInt() @Min(1) @Max(20) parcelCount?: number;

  /** Insured value in stotinki (EUR cents); 0/absent = no insurance. */
  @IsOptional() @IsInt() @Min(0) @Max(1_000_000) declaredValueStotinki?: number;

  /** „Обратна разписка" — signed delivery receipt returned to the sender. Currently
   *  honoured by Speedy only; Econt ignores it (kept here so the shared UI payload
   *  validates for either carrier). */
  @IsOptional() @IsBoolean() returnReceipt?: boolean;
}
