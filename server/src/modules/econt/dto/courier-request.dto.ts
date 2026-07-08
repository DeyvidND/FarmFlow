import { IsArray, IsString, IsOptional, ArrayNotEmpty, ArrayMaxSize, IsUUID, Matches } from 'class-validator';

export class CourierRequestDto {
  // Shipment UUIDs (our ids) to attach to the pickup. Capped at 50 to match
  // MAX_BULK_LABELS (econt.service.ts) — keeps the IN(...) query bounded.
  @IsArray() @ArrayNotEmpty() @ArrayMaxSize(50) @IsUUID(undefined, { each: true })
  shipmentIds!: string[];

  // Pickup window — "YYYY-MM-DD HH:mm" style strings Econt accepts; optional.
  @IsOptional() @IsString() @Matches(/^[\d :-]{0,25}$/)
  timeFrom?: string;
  @IsOptional() @IsString() @Matches(/^[\d :-]{0,25}$/)
  timeTo?: string;
}
