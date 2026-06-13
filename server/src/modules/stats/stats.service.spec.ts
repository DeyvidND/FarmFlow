import { buildStatsAxis, computeReturning, SPARSE_MIN, type StatsRange } from './stats.service';

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

describe('SPARSE_MIN', () => {
  it('is a small positive threshold', () => {
    expect(SPARSE_MIN).toBeGreaterThan(0);
    expect(SPARSE_MIN).toBeLessThan(30);
  });
});
