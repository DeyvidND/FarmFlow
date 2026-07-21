import { IsInt, IsNumber, IsOptional, IsString, Matches, Max, Min } from 'class-validator';

/** A day + optional courier split, for the delivery-window batch endpoints
 *  (generate / approve / notify). `ends` mirrors the route screen's per-courier
 *  end csv so generated windows match exactly what the operator is viewing. */
export class DeliveryWindowDayDto {
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date трябва да е YYYY-MM-DD' })
  date?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10)
  couriers?: number;

  /** Per-courier end modes csv, e.g. "home,last" — same as GET /orders/route?ends. */
  @IsOptional()
  @IsString()
  ends?: string;

  /** When the courier starts the round (Europe/Sofia hour, 0–23). Overrides the
   *  saved settings.routing.dayStartHour for this generation; the operator is
   *  asked each time in the „Часове за доставка" modal. Omitted ⇒ fall back to
   *  the stored default. */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(23)
  startHour?: number;

  /** The courier's CURRENT position (from the route screen's live GPS / last
   *  delivered stop). When present, generation measures the first stop's
   *  distance/time from here instead of the farm. Both required together. */
  @IsOptional()
  @IsNumber()
  @Min(-90)
  @Max(90)
  startLat?: number;

  @IsOptional()
  @IsNumber()
  @Min(-180)
  @Max(180)
  startLng?: number;
}

/** Task #13 — operator lightly edits one order's generated window. */
export class UpdateDeliveryWindowDto {
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'start трябва да е ЧЧ:ММ' })
  start!: string;

  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'end трябва да е ЧЧ:ММ' })
  end!: string;
}

/** Task #13 — cascade shift: nudge one stop's window by `deltaMin` minutes and
 *  slide every later stop on the same courier leg by the same amount. */
export class ShiftDeliveryWindowDto {
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date трябва да е YYYY-MM-DD' })
  date!: string;

  @IsString()
  fromStopId!: string;

  /** Signed minutes to shift by (e.g. +5 or -10); 0 is rejected in the service.
   *  Bounded to a sane single-nudge range so a typo can't wrap the whole day. */
  @IsInt()
  @Min(-720)
  @Max(720)
  deltaMin!: number;
}
