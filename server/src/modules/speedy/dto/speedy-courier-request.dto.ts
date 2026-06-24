import { IsArray, IsString, ArrayNotEmpty, IsOptional, MaxLength } from 'class-validator';

/** Request a Speedy courier pickup for already-created shipments. */
export class SpeedyCourierRequestDto {
  @IsArray() @ArrayNotEmpty() @IsString({ each: true })
  shipmentIds!: string[];

  // Pickup date (YYYY-MM-DD) + time window; optional (Speedy auto-adjusts).
  @IsOptional() @IsString() @MaxLength(10)
  pickupDate?: string;
  @IsOptional() @IsString() @MaxLength(5)
  timeFrom?: string;
  @IsOptional() @IsString() @MaxLength(5)
  timeTo?: string;
}
