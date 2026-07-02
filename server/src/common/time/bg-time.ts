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

/** SQL fragment: a UTC-stored timestamp column reduced to its BG-local date.
 *  Prefer {@link bgDayBounds} for "orders on day X" filters — the `::date` cast
 *  here is non-sargable (defeats the `(tenant_id, created_at, id)` index and
 *  forces a full scan). Keep using this only where a range can't express the
 *  predicate (e.g. the routing `coalesce(slot_date, bgDate(created))`). */
export function bgDate(col: PgColumn | SQL): SQL {
  return sql`(${col} AT TIME ZONE 'UTC' AT TIME ZONE ${BG_TZ})::date`;
}

/** Offset (ms) of Europe/Sofia at a given instant: (wall-clock as-UTC) − instant.
 *  +2h in winter, +3h in summer (DST). */
function bgOffsetMs(instant: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: BG_TZ,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);
  const f: Record<string, string> = {};
  for (const p of parts) f[p.type] = p.value;
  const asUtc = Date.UTC(+f.year, +f.month - 1, +f.day, +f.hour, +f.minute, +f.second);
  return asUtc - instant.getTime();
}

/** The UTC instant of 00:00 Europe/Sofia on the given BG calendar date. DST never
 *  switches at midnight in Bulgaria (it's at 03:00/04:00), so the single-step
 *  offset resolution is exact for midnight. */
function bgMidnightUtc(day: string): Date {
  const [y, m, d] = day.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, 0, 0, 0);
  return new Date(guess - bgOffsetMs(new Date(guess)));
}

/** Current time-of-day in Bulgaria local time, as minutes since midnight
 *  (0-1439). Same-day-only comparisons (e.g. "is it within N hours of a slot
 *  today?") never cross Bulgaria's DST boundary (03:00/04:00 vs. commercial
 *  hours), so plain minute arithmetic is safe — no instant/offset math needed. */
export function bgNowMinutes(): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: BG_TZ,
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(new Date());
  const f: Record<string, string> = {};
  for (const p of parts) f[p.type] = p.value;
  return Number(f.hour) * 60 + Number(f.minute);
}

/** Parse "HH:MM" (or "HH:MM:SS") into minutes since midnight. */
export function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(':');
  return Number(h) * 60 + Number(m);
}

/** The BG calendar date `n` days after `day` (date-only arithmetic, tz-safe). */
export function bgAddDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d) + n * 86_400_000);
  const mm = String(t.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(t.getUTCDate()).padStart(2, '0');
  return `${t.getUTCFullYear()}-${mm}-${dd}`;
}

/**
 * UTC instant bounds `[from, to)` for one BG-local calendar day. `created_at` is
 * stored as UTC, so `created_at >= from AND created_at < to` selects exactly the
 * orders placed on that BG day — and is served by the `(tenant_id, created_at, id)`
 * index (a range scan) instead of the full-table `::date` cast. `date` defaults
 * to today (BG). `to` is the next BG midnight (handles 23h/25h DST days correctly).
 */
export function bgDayBounds(date?: string): { from: Date; to: Date } {
  const day = date ?? bgToday();
  return { from: bgMidnightUtc(day), to: bgMidnightUtc(bgAddDays(day, 1)) };
}
