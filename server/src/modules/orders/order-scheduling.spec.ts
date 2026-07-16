import { scheduledForRange, pickNearestDay } from './order-scheduling';
import { bgDayBounds } from '../../common/time/bg-time';

/**
 * Drizzle's `and(...)`/`or(...)` build a tree of `SQL` nodes whose
 * `queryChunks` mix raw `StringChunk`s, `PgColumn` references, and `Param`
 * wrappers around bound values. Deep-equalling that tree against a
 * hand-built expectation is fragile, and `JSON.stringify` only proves a
 * column name appears *somewhere* — it can't tell a correct inclusive
 * `[from, to]` range from a broken one that ignores `to` entirely (both
 * still mention the same `date`/`created_at` column objects). Instead we
 * walk the tree and pull out `{ column, value }` pairs for every
 * `col <op> param` leaf — the operator token itself is just another
 * `StringChunk` the walk skips over, so this works for `gte`/`lte` alike.
 * Same approach as orders.mine.spec.ts's `extractEqPairs`.
 */
function extractBoundPairs(node: unknown): Array<{ column: string; value: unknown }> {
  const pairs: Array<{ column: string; value: unknown }> = [];
  let pendingColumn: string | null = null;

  function walk(n: any): void {
    if (n == null || typeof n !== 'object') return;
    const ctor = n.constructor?.name;
    if (ctor === 'PgColumn' || (typeof n.name === 'string' && n.table !== undefined)) {
      pendingColumn = n.name;
      return;
    }
    if (ctor === 'Param') {
      if (pendingColumn) {
        pairs.push({ column: pendingColumn, value: n.value });
        pendingColumn = null;
      }
      return;
    }
    if (Array.isArray(n.queryChunks)) {
      for (const c of n.queryChunks) walk(c);
    }
  }

  const sqlNode = (node as any)?.getSQL ? (node as any).getSQL() : node;
  walk(sqlNode);
  return pairs;
}

describe('scheduledForRange', () => {
  it('binds the slot-date range AND the slotless createdAt fallback to the real from/to values', () => {
    const cond = scheduledForRange('2026-07-10', '2026-07-12');
    expect(cond).toBeDefined();
    const pairs = extractBoundPairs(cond);

    // deliverySlots.date must be bounded by BOTH the literal `from` and `to`
    // values (gte(from) and lte(to)) — a substring check on "date" can't
    // distinguish this from a broken range that drops the `to` bound.
    expect(pairs).toEqual(
      expect.arrayContaining([
        { column: 'date', value: '2026-07-10' },
        { column: 'date', value: '2026-07-12' },
      ]),
    );

    // The slotless createdAt fallback must span the FULL range: lo = start of
    // the `from` day, hi = end (exclusive) of the `to` day — not just the
    // `from` day. This is the assertion that would catch `hi` being computed
    // from `from` instead of `to`, or the `to` bound being ignored entirely.
    const { from: lo } = bgDayBounds('2026-07-10');
    const { to: hi } = bgDayBounds('2026-07-12');
    expect(pairs).toEqual(
      expect.arrayContaining([
        { column: 'created_at', value: lo },
        { column: 'created_at', value: hi },
      ]),
    );
  });

  it('single-day range still includes the createdAt fallback, and a different `to` changes the bound values', () => {
    const single = scheduledForRange('2026-07-10', '2026-07-10');
    const singlePairs = extractBoundPairs(single);
    expect(singlePairs.some((p) => p.column === 'created_at')).toBe(true);

    // Same `from`, different `to`: the two conditions must bind different
    // parameter sets. If `scheduledForRange` degenerated into an open-ended
    // `date >= from` (ignoring `to`), or computed `hi` from `from`, these two
    // would bind identically despite the very different `to` values.
    const shortRange = scheduledForRange('2026-07-10', '2026-07-12');
    const longRange = scheduledForRange('2026-07-10', '2026-07-20');
    const shortPairs = extractBoundPairs(shortRange);
    const longPairs = extractBoundPairs(longRange);
    expect(shortPairs).not.toEqual(longPairs);

    // Concretely: the createdAt upper bound (hi) must track the DIFFERENT
    // `to` value in each case, not collapse to the same (or `from`-derived)
    // instant.
    const hiShort = bgDayBounds('2026-07-12').to;
    const hiLong = bgDayBounds('2026-07-20').to;
    expect(hiShort).not.toEqual(hiLong);
    const shortCreatedAtValues = shortPairs.filter((p) => p.column === 'created_at').map((p) => p.value);
    const longCreatedAtValues = longPairs.filter((p) => p.column === 'created_at').map((p) => p.value);
    expect(shortCreatedAtValues).toContainEqual(hiShort);
    expect(longCreatedAtValues).toContainEqual(hiLong);

    // Same check for deliverySlots.date's upper bound.
    const shortDateValues = shortPairs.filter((p) => p.column === 'date').map((p) => p.value);
    const longDateValues = longPairs.filter((p) => p.column === 'date').map((p) => p.value);
    expect(shortDateValues).toContainEqual('2026-07-12');
    expect(longDateValues).toContainEqual('2026-07-20');
    expect(shortDateValues).not.toContainEqual('2026-07-20');
  });
});

describe('pickNearestDay', () => {
  const anchor = '2026-07-16'; // a Thursday

  it('returns the anchor unchanged when it has orders', () => {
    expect(pickNearestDay(anchor, new Set([anchor, '2026-07-18']), 2)).toBe(anchor);
  });

  it('jumps to the nearest day with orders when the anchor is empty', () => {
    // Orders only two days ahead → land there (nothing nearer).
    expect(pickNearestDay(anchor, new Set(['2026-07-18']), 2)).toBe('2026-07-18');
    // Orders one day behind → nearer than anything else.
    expect(pickNearestDay(anchor, new Set(['2026-07-15', '2026-07-13']), 2)).toBe('2026-07-15');
  });

  it('prefers the FUTURE side on a tie (equal distance both ways)', () => {
    // Both ±1 have orders → the future one (+1) wins.
    expect(pickNearestDay(anchor, new Set(['2026-07-15', '2026-07-17']), 2)).toBe('2026-07-17');
    // Both ±2 have orders, ±1 empty → future +2 wins.
    expect(pickNearestDay(anchor, new Set(['2026-07-14', '2026-07-18']), 2)).toBe('2026-07-18');
  });

  it('checks distance outward — a nearer past day beats a farther future day', () => {
    // -1 (near) vs +2 (far): the nearer past day wins over the farther future.
    expect(pickNearestDay(anchor, new Set(['2026-07-15', '2026-07-18']), 2)).toBe('2026-07-15');
  });

  it('stays on the anchor when no day in the ±span window has orders', () => {
    // Orders exist, but outside the ±2 window → no jump.
    expect(pickNearestDay(anchor, new Set(['2026-07-25']), 2)).toBe(anchor);
    expect(pickNearestDay(anchor, new Set(), 2)).toBe(anchor);
  });

  it('respects the span bound (span=1 ignores a ±2 day)', () => {
    expect(pickNearestDay(anchor, new Set(['2026-07-18']), 1)).toBe(anchor);
    expect(pickNearestDay(anchor, new Set(['2026-07-17']), 1)).toBe('2026-07-17');
  });
});
