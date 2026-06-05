import { and, or, eq, lt, gt, type SQL } from 'drizzle-orm';
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

/** Strict keyset predicate: rows after `cursor`. DESC → (created,id) < (c,i); ASC → > . */
export function keysetAfter(
  createdCol: PgColumn,
  idCol: PgColumn,
  cursor: CursorPos,
  dir: 'asc' | 'desc',
): SQL {
  const cmp = dir === 'desc' ? lt : gt;
  return or(
    cmp(createdCol, cursor.createdAt),
    and(eq(createdCol, cursor.createdAt), cmp(idCol, cursor.id)),
  )!;
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
