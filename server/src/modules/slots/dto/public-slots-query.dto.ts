import { IsOptional, Matches } from 'class-validator';

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const ymdMessage = (field: string) => ({ message: `${field} трябва да е във формат YYYY-MM-DD` });

/**
 * Query params for the PUBLIC, unauthenticated GET /public/:slug/slots.
 * `date` = legacy single-day; `from`/`to` = the picker's ranged window. Each is a
 * plain YYYY-MM-DD string that flows straight into eq/gte/lte(deliverySlots.date, …)
 * — a Postgres `date` column. Without this shape guard a raw `?date=garbage` reaches
 * the column and 500s with a 22007 on an endpoint any anonymous visitor can hit.
 * (Out-of-calendar-but-well-shaped values like 2026-99-99 still pass here and are
 * caught downstream by the GlobalExceptionFilter's 22008→400 mapping.)
 */
export class PublicSlotsQueryDto {
  @IsOptional()
  @Matches(YMD, ymdMessage('date'))
  date?: string;

  @IsOptional()
  @Matches(YMD, ymdMessage('from'))
  from?: string;

  @IsOptional()
  @Matches(YMD, ymdMessage('to'))
  to?: string;
}
