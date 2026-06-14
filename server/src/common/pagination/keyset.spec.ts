import { PgDialect } from 'drizzle-orm/pg-core';
import { orders } from '@farmflow/db';
import { clampLimit, buildPage, keysetAfter, DEFAULT_LIMIT, MAX_LIMIT } from './keyset';

describe('keysetAfter (tz-agnostic predicate)', () => {
  const dialect = new PgDialect();
  const cur = { createdAt: new Date('2026-06-14T10:00:00.000Z'), id: 'a1b2c3d4-0000-0000-0000-000000000000' };

  it('binds the cursor value as an ISO string cast to ::timestamp (not a raw Date)', () => {
    const { sql, params } = dialect.sqlToQuery(keysetAfter(orders.createdAt, orders.id, cur, 'desc'));
    // The whole bug fix: never bind a Date — bind ISO text + ::timestamp so a non-UTC
    // PG session can't tz-shift the boundary relative to the timezone-less column.
    expect(sql).toContain('::timestamp');
    expect(sql).toContain('::uuid');
    expect(params[0]).toBe('2026-06-14T10:00:00.000Z');
    expect(params[0]).not.toBeInstanceOf(Date);
    expect(params[1]).toBe(cur.id);
  });

  it('uses < for desc and > for asc (row-value comparison)', () => {
    expect(dialect.sqlToQuery(keysetAfter(orders.createdAt, orders.id, cur, 'desc')).sql).toContain('<');
    expect(dialect.sqlToQuery(keysetAfter(orders.createdAt, orders.id, cur, 'asc')).sql).toContain('>');
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
  const cursorOf = (r: { createdAt: Date; id: string }) => r;
  const rows = Array.from({ length: 4 }, (_, i) => ({
    createdAt: new Date(2026, 0, i + 1),
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
