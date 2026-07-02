import { sql, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { encodeCursor, type CursorPos } from './cursor';

export interface Paginated<T> {
  items: T[];
  nextCursor: string | null;
  total?: number;
}

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 100;

export function clampLimit(raw?: number): number {
  if (raw == null || Number.isNaN(raw)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(raw)));
}

/**
 * Strict keyset predicate: rows after `cursor`. Uses a ROW-VALUE comparison
 * `(created_at, id) < (c, i)` (not the OR expansion) — this is the form Postgres
 * turns into a single index range scan on `(…, created_at, id)`, so the scan
 * seeks straight to the cursor and stops at LIMIT (no Sort, no full read).
 *
 * The cursor's timestamp is the micro-precision, tz-naive string from {@link cursorTs}
 * (NOT a JS Date — see {@link CursorPos}), bound cast to a NAIVE `::timestamp` (and the
 * id to `::uuid`). Every keyset column in this codebase is `timestamp` WITHOUT time
 * zone, and every id column is `uuid`. If we bound the cursor as a Date, a Postgres
 * session whose timezone isn't UTC would tz-shift the bound value relative to the
 * timezone-less column, putting the keyset boundary in the wrong place — pages then
 * overlap or never advance. The `cursorTs` string is UTC wall-clock, matching how the
 * columns are stored, and `::timestamp` strips any zone so the comparison is
 * tz-agnostic regardless of session tz. The cast is on the BOUND VALUE only — the
 * indexed column is never wrapped in a function, so the `(…, created_at, id)` index
 * range scan is preserved.
 *
 * NOTE: if a future caller keysets on a `timestamptz` column, this `::timestamp`
 * cast is wrong for it — that column needs `::timestamptz`. Audit the column type
 * before adding a new caller.
 */
export function keysetAfter(
  createdCol: PgColumn,
  idCol: PgColumn,
  cursor: CursorPos,
  dir: 'asc' | 'desc',
): SQL {
  const c = sql`${cursor.createdAt}::timestamp`;
  const i = sql`${cursor.id}::uuid`;
  return dir === 'desc'
    ? sql`(${createdCol}, ${idCol}) < (${c}, ${i})`
    : sql`(${createdCol}, ${idCol}) > (${c}, ${i})`;
}

/**
 * SELECT expression that yields a keyset row's boundary timestamp as a
 * micro-precision, tz-naive string (`YYYY-MM-DDTHH24:MI:SS.US`, e.g.
 * `2026-07-02T12:00:00.123456`). Select it under the {@link KEYSET_TS} key and pass
 * the rows to {@link buildKeysetPage} — the cursor then carries the full precision
 * Postgres stores, so pagination strictly advances even when many rows share a
 * millisecond, and the column is stripped from the returned items. Format matches a
 * naive ISO timestamp, round-tripping through `::timestamp` in {@link keysetAfter}.
 * Projection only — the underlying column stays unwrapped in WHERE/ORDER BY, so the
 * index range scan is untouched.
 */
export function cursorTs(col: PgColumn): SQL<string> {
  return sql<string>`to_char(${col}, 'YYYY-MM-DD"T"HH24:MI:SS.US')`;
}

/**
 * Reserved key under which paginated queries project their boundary timestamp
 * (see {@link cursorTs}). {@link buildKeysetPage} reads it to build the cursor and
 * strips it from the returned items so this internal column never reaches the API.
 */
export const KEYSET_TS = '__keysetTs' as const;

/** Turn `limit+1` rows into a page. `cursorOf` extracts the keyset position of a row. */
export function buildPage<T>(
  rows: T[],
  limit: number,
  cursorOf: (row: T) => CursorPos,
): Paginated<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  const nextCursor = hasMore && last ? encodeCursor(cursorOf(last)) : null;
  return { items, nextCursor };
}

/**
 * Like {@link buildPage}, but reads the keyset boundary from the reserved
 * {@link KEYSET_TS} column (a micro-precision string from {@link cursorTs}) and the
 * row's `id`, then strips `KEYSET_TS` from the returned items. Callers just add
 * `{ [KEYSET_TS]: cursorTs(col) }` to their SELECT — no `cursorOf`, and the internal
 * column is never leaked to the response.
 */
export function buildKeysetPage<T extends { id: string }>(
  rows: Array<T & { [KEYSET_TS]: string }>,
  limit: number,
): Paginated<T> {
  const hasMore = rows.length > limit;
  const sliced = hasMore ? rows.slice(0, limit) : rows;
  const last = sliced[sliced.length - 1];
  const nextCursor =
    hasMore && last ? encodeCursor({ createdAt: last[KEYSET_TS], id: last.id }) : null;
  const items = sliced.map(({ [KEYSET_TS]: _ts, ...rest }) => rest as unknown as T);
  return { items, nextCursor };
}
