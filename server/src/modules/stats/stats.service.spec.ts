import {
  buildStatsAxis,
  computeReturning,
  fillWeekday,
  pickSlowProducts,
  SPARSE_MIN,
  type StatsRange,
} from './stats.service';

describe('buildStatsAxis', () => {
  const today = '2026-06-13'; // a Saturday

  it('7d → 7 daily keys ending today', () => {
    const { keys, sinceDay } = buildStatsAxis('7d', today);
    expect(keys).toHaveLength(7);
    expect(keys[keys.length - 1]).toBe('2026-06-13');
    expect(keys[0]).toBe('2026-06-07');
    expect(sinceDay).toBe('2026-06-07');
  });

  it('30d → 30 daily keys ending today', () => {
    const { keys, sinceDay } = buildStatsAxis('30d', today);
    expect(keys).toHaveLength(30);
    expect(keys[keys.length - 1]).toBe('2026-06-13');
    expect(keys[0]).toBe('2026-05-15');
    expect(sinceDay).toBe('2026-05-15');
  });

  it('90d → 13 weekly Monday keys, 7 days apart, none after today', () => {
    const { keys, sinceDay } = buildStatsAxis('90d', today);
    expect(keys).toHaveLength(13);
    expect(sinceDay).toBe(keys[0]);
    // every key is a Monday
    for (const k of keys) {
      const [y, m, d] = k.split('-').map(Number);
      expect(new Date(Date.UTC(y, m - 1, d)).getUTCDay()).toBe(1);
    }
    // consecutive keys are exactly 7 days apart
    for (let i = 1; i < keys.length; i++) {
      const a = Date.parse(`${keys[i - 1]}T00:00:00Z`);
      const b = Date.parse(`${keys[i]}T00:00:00Z`);
      expect((b - a) / 86_400_000).toBe(7);
    }
    // last Monday is on or before today
    expect(keys[keys.length - 1] <= today).toBe(true);
  });

  it('1y → 12 monthly keys ending this month', () => {
    const { keys, sinceDay } = buildStatsAxis('1y', today);
    expect(keys).toHaveLength(12);
    expect(keys[keys.length - 1]).toBe('2026-06');
    expect(keys[0]).toBe('2025-07');
    expect(sinceDay).toBe('2025-07-01');
  });

  it('handles year boundary for month buckets', () => {
    const { keys } = buildStatsAxis('1y', '2026-01-09');
    expect(keys[keys.length - 1]).toBe('2026-01');
    expect(keys[0]).toBe('2025-02');
  });

  it('all ranges produce non-empty, ascending axes', () => {
    for (const range of ['7d', '30d', '90d', '1y'] as StatsRange[]) {
      const { keys } = buildStatsAxis(range, today);
      expect(keys.length).toBeGreaterThan(0);
      const sorted = [...keys].sort();
      expect(keys).toEqual(sorted);
    }
  });
});

describe('computeReturning', () => {
  it('splits window customers into returning (seen before) and new', () => {
    const r = computeReturning(['a', 'b', 'c'], ['b', 'x', 'y']);
    expect(r).toEqual({ customerCount: 3, returningCustomers: 1, newCustomers: 2 });
  });

  it('all new when none appear in prior set', () => {
    expect(computeReturning(['a', 'b'], [])).toEqual({
      customerCount: 2,
      returningCustomers: 0,
      newCustomers: 2,
    });
  });

  it('all returning when every window customer ordered before', () => {
    expect(computeReturning(['a', 'b'], ['a', 'b', 'c'])).toEqual({
      customerCount: 2,
      returningCustomers: 2,
      newCustomers: 0,
    });
  });

  it('empty window → zeros', () => {
    expect(computeReturning([], ['a'])).toEqual({
      customerCount: 0,
      returningCustomers: 0,
      newCustomers: 0,
    });
  });
});

describe('fillWeekday', () => {
  it('fills all 7 weekdays ascending, zeroing the missing ones', () => {
    const out = fillWeekday([
      { dow: 3, orders: 5, revenueStotinki: 1000 },
      { dow: 0, orders: 2, revenueStotinki: 400 },
    ]);
    expect(out).toHaveLength(7);
    expect(out.map((r) => r.dow)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(out[0]).toEqual({ dow: 0, orders: 2, revenueStotinki: 400 });
    expect(out[3]).toEqual({ dow: 3, orders: 5, revenueStotinki: 1000 });
    expect(out[1]).toEqual({ dow: 1, orders: 0, revenueStotinki: 0 });
  });

  it('empty input → 7 zero days', () => {
    const out = fillWeekday([]);
    expect(out).toHaveLength(7);
    expect(out.every((r) => r.orders === 0 && r.revenueStotinki === 0)).toBe(true);
  });
});

describe('pickSlowProducts', () => {
  const p = (name: string, quantity: number, revenueStotinki: number) => ({ name, quantity, revenueStotinki });

  it('surfaces zero-sellers first, then lowest qty, capped', () => {
    const out = pickSlowProducts(
      [p('A', 10, 5000), p('B', 0, 0), p('C', 2, 800), p('D', 0, 0), p('E', 1, 300)],
      3,
    );
    expect(out.map((x) => x.name)).toEqual(['B', 'D', 'E']);
  });

  it('does not mutate the input array', () => {
    const input = [p('A', 3, 0), p('B', 1, 0)];
    const copy = [...input];
    pickSlowProducts(input, 5);
    expect(input).toEqual(copy);
  });

  it('returns at most `limit` rows', () => {
    const out = pickSlowProducts([p('A', 1, 0), p('B', 2, 0), p('C', 3, 0)], 2);
    expect(out).toHaveLength(2);
  });
});

describe('SPARSE_MIN', () => {
  it('is a small positive threshold', () => {
    expect(SPARSE_MIN).toBeGreaterThan(0);
    expect(SPARSE_MIN).toBeLessThan(30);
  });
});
