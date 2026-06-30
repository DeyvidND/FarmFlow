import { IsBoolean, IsInt, IsNumber, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/**
 * Optional per-shipment overrides the farmer can set when turning a courier DRAFT
 * into a real Speedy waybill. Mirrors the Econt FinalizeDraftDto — every field is
 * optional and falls back to the farm's package defaults.
 */
export class FinalizeDraftDto {
  /** Real parcel weight in kg — drives the courier price. Omit → farm default (or 1kg). */
  @IsOptional() @IsNumber() @Min(0.01) @Max(1000) weightKg?: number;

  /** What's inside — printed on the waybill. Omit → farm default. */
  @IsOptional() @IsString() @MaxLength(100) contents?: string;

  /** How many separate boxes this shipment is. Omit → 1. */
  @IsOptional() @IsInt() @Min(1) @Max(20) parcelCount?: number;

  /** Insured value in stotinki (EUR cents); 0/absent = no insurance. */
  @IsOptional() @IsInt() @Min(0) @Max(1_000_000) declaredValueStotinki?: number;

  /** „Обратна разписка" — a signed delivery receipt comes back to the sender (Speedy). */
  @IsOptional() @IsBoolean() returnReceipt?: boolean;
}
