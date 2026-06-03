import { sql, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';

/**
 * The product operates in Bulgaria. `created_at` columns are `timestamp`
 * (no tz) storing UTC wall-clock (DB session tz = UTC). Using the raw UTC date
 * for "today" / day-grouping makes orders placed after local midnight land on
 * the previous day (BG is UTC+2/+3). These helpers keep day logic in BG local
 * time so the dashboard, route, and digest all agree with the wall clock.
 */
export const BG_TZ = 'Europe/Sofia';

/** Current calendar date (YYYY-MM-DD) in Bulgaria local time. */
export function bgToday(): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: BG_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/** SQL fragment: a UTC-stored timestamp column reduced to its BG-local date. */
export function bgDate(col: PgColumn | SQL): SQL {
  return sql`(${col} AT TIME ZONE 'UTC' AT TIME ZONE ${BG_TZ})::date`;
}
