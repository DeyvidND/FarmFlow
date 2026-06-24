import { IsArray, IsString, IsOptional, ArrayNotEmpty, Matches } from 'class-validator';

export class CourierRequestDto {
  // Shipment UUIDs (our ids) to attach to the pickup.
  @IsArray() @ArrayNotEmpty() @IsString({ each: true })
  shipmentIds!: string[];

  // Pickup window — "YYYY-MM-DD HH:mm" style strings Econt accepts; optional.
  @IsOptional() @IsString() @Matches(/^[\d :-]{0,25}$/)
  timeFrom?: string;
  @IsOptional() @IsString() @Matches(/^[\d :-]{0,25}$/)
  timeTo?: string;
}
