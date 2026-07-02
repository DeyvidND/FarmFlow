import { PgDialect } from 'drizzle-orm/pg-core';
import { orders } from '@fermeribg/db';
import {
  clampLimit,
  buildPage,
  buildKeysetPage,
  cursorTs,
  keysetAfter,
  KEYSET_TS,
  DEFAULT_LIMIT,
  MAX_LIMIT,
} from './keyset';
import { decodeCursor } from './cursor';

describe('keysetAfter (tz-agnostic, full-precision predicate)', () => {
  const dialect = new PgDialect();
  // Micro-precision, tz-naive boundary string (as produced by cursorTs).
  const cur = { createdAt: '2026-06-14T10:00:00.123456', id: 'a1b2c3d4-0000-0000-0000-000000000000' };

  it('binds the micro-precision cursor value cast to ::timestamp (never a Date, never truncated)', () => {
    const { sql, params } = dialect.sqlToQuery(keysetAfter(orders.createdAt, orders.id, cur, 'desc'));
    // Never bind a Date — bind the tz-naive string + ::timestamp so a non-UTC PG
    // session can't tz-shift the boundary relative to the timezone-less column, and
    // so the microseconds survive (a ms-truncated bound stalls same-ms blocks).
    expect(sql).toContain('::timestamp');
    expect(sql).toContain('::uuid');
    expect(params[0]).toBe('2026-06-14T10:00:00.123456');
    expect(params[0]).not.toBeInstanceOf(Date);
    expect(params[1]).toBe(cur.id);
  });

  it('does NOT wrap the indexed column in a function (preserves the index range scan)', () => {
    const { sql } = dialect.sqlToQuery(keysetAfter(orders.createdAt, orders.id, cur, 'desc'));
    expect(sql).not.toContain('date_trunc');
    expect(sql).not.toMatch(/to_char\([^)]*created_at/i);
  });

  it('uses < for desc and > for asc (row-value comparison)', () => {
    expect(dialect.sqlToQuery(keysetAfter(orders.createdAt, orders.id, cur, 'desc')).sql).toContain('<');
    expect(dialect.sqlToQuery(keysetAfter(orders.createdAt, orders.id, cur, 'asc')).sql).toContain('>');
  });
});

describe('cursorTs', () => {
  const dialect = new PgDialect();
  it('projects the column as a micro-precision (.US) tz-naive ISO string', () => {
    const { sql } = dialect.sqlToQuery(cursorTs(orders.createdAt));
    expect(sql).toContain('to_char');
    expect(sql).toContain('"T"');
    expect(sql).toContain('.US'); // microseconds — the precision that fixes the stall
  });
});

describe('clampLimit', () => {
  it('defaults when absent / NaN', () => {
    expect(clampLimit(undefined)).toBe(DEFAULT_LIMIT);
    expect(clampLimit(NaN)).toBe(DEFAULT_LIMIT);
  });
  it('clamps to [1, MAX_LIMIT]', () => {
    expect(clampLimit(0)).toBe(1);
    expect(clampLimit(9999)).toBe(MAX_LIMIT);
    expect(clampLimit(25)).toBe(25);
  });
});

describe('buildPage', () => {
  const cursorOf = (r: { createdAt: string; id: string }) => r;
  const rows = Array.from({ length: 4 }, (_, i) => ({
    createdAt: `2026-01-0${i + 1}T00:00:00.000000`,
    id: `id-${i}`,
  }));

  it('trims the +1 sentinel and emits a nextCursor when more exist', () => {
    const page = buildPage(rows, 3, cursorOf); // 4 rows, limit 3 → hasMore
    expect(page.items).toHaveLength(3);
    expect(page.items[2].id).toBe('id-2');
    expect(page.nextCursor).not.toBeNull();
  });

  it('null cursor at the tail', () => {
    const page = buildPage(rows.slice(0, 2), 3, cursorOf); // 2 rows, limit 3 → no more
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).toBeNull();
  });

  it('exactly `limit` rows → no more', () => {
    const page = buildPage(rows.slice(0, 3), 3, cursorOf);
    expect(page.items).toHaveLength(3);
    expect(page.nextCursor).toBeNull();
  });
});

describe('buildKeysetPage', () => {
  const row = (id: string, ts: string) => ({ id, name: `n-${id}`, [KEYSET_TS]: ts });

  it('strips the internal KEYSET_TS column from the returned items', () => {
    const page = buildKeysetPage([row('a', '2026-01-01T00:00:00.000001')], 3);
    expect(page.items).toEqual([{ id: 'a', name: 'n-a' }]);
    expect(page.items[0]).not.toHaveProperty(KEYSET_TS);
  });

  it('builds the nextCursor from the boundary row carrying FULL micro precision', () => {
    // Three rows sharing a millisecond (…123) but differing in microseconds: the
    // exact stall scenario. The cursor must carry the boundary micros, not ms, so
    // the next page starts strictly after this row.
    const rows = [
      row('a', '2026-01-01T12:00:00.123001'),
      row('b', '2026-01-01T12:00:00.123002'),
      row('c', '2026-01-01T12:00:00.123003'),
    ];
    const page = buildKeysetPage(rows, 2); // limit 2 → boundary is row 'b'
    expect(page.items.map((r) => r.id)).toEqual(['a', 'b']);
    const decoded = decodeCursor(page.nextCursor!);
    expect(decoded).toEqual({ createdAt: '2026-01-01T12:00:00.123002', id: 'b' });
    // Would be '…123' (ms) under the old Date-based cursor — that truncation is the bug.
    expect(decoded?.createdAt).not.toBe('2026-01-01T12:00:00.123');
  });

  it('null cursor at the tail', () => {
    const page = buildKeysetPage([row('a', '2026-01-01T00:00:00.000000')], 3);
    expect(page.nextCursor).toBeNull();
  });
});
