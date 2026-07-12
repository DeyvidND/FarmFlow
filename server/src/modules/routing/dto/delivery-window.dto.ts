import { IsInt, IsOptional, IsString, Matches, Max, Min } from 'class-validator';

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
}

/** Task #13 — operator lightly edits one order's generated window. */
export class UpdateDeliveryWindowDto {
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'start трябва да е ЧЧ:ММ' })
  start!: string;

  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'end трябва да е ЧЧ:ММ' })
  end!: string;
}
