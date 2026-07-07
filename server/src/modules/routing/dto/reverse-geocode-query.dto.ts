import { Type } from 'class-transformer';
import { IsLatitude, IsLongitude } from 'class-validator';

/** Query params for GET orders/route/reverse-geocode. */
export class ReverseGeocodeQueryDto {
  @Type(() => Number)
  @IsLatitude()
  lat!: number;

  @Type(() => Number)
  @IsLongitude()
  lng!: number;
}
