import { IsLatitude, IsLongitude, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Fix a route stop whose address couldn't be geocoded. Either:
 *  - send `address` alone → the server geocodes it (biased to the farm region)
 *    and saves the resulting pin, or
 *  - send `lat`+`lng` (a manual pin dropped on the map), optionally with a
 *    cleaned-up `address` to store alongside.
 */
export class SetStopLocationDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  address?: string;

  @IsOptional()
  @IsLatitude()
  lat?: number;

  @IsOptional()
  @IsLongitude()
  lng?: number;
}
