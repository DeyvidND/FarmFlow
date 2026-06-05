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
 */
export function keysetAfter(
  createdCol: PgColumn,
  idCol: PgColumn,
  cursor: CursorPos,
  dir: 'asc' | 'desc',
): SQL {
  return dir === 'desc'
    ? sql`(${createdCol}, ${idCol}) < (${cursor.createdAt}, ${cursor.id})`
    : sql`(${createdCol}, ${idCol}) > (${cursor.createdAt}, ${cursor.id})`;
}

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
