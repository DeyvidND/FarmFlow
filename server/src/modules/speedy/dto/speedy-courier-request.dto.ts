import { IsArray, IsString, ArrayNotEmpty, ArrayMaxSize, IsUUID, IsOptional, MaxLength } from 'class-validator';

/** Request a Speedy courier pickup for already-created shipments. */
export class SpeedyCourierRequestDto {
  // Capped at 50 to match MAX_BULK_LABELS (speedy.service.ts) — keeps the
  // IN(...) query bounded.
  @IsArray() @ArrayNotEmpty() @ArrayMaxSize(50) @IsUUID(undefined, { each: true })
  shipmentIds!: string[];

  // Pickup date (YYYY-MM-DD) + time window; optional (Speedy auto-adjusts).
  @IsOptional() @IsString() @MaxLength(10)
  pickupDate?: string;
  @IsOptional() @IsString() @MaxLength(5)
  timeFrom?: string;
  @IsOptional() @IsString() @MaxLength(5)
  timeTo?: string;
}
