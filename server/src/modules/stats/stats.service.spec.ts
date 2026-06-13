import { BadRequestException } from '@nestjs/common';
import {
  buildAxis,
  pickBucket,
  resolveWindow,
  daySpanInclusive,
  isValidDay,
  computeReturning,
  fillWeekday,
  pickSlowProducts,
  SPARSE_MIN,
  MAX_RANGE_DAYS,
} from './stats.service';

describe('resolveWindow (presets)', () => {
  const today = '2026-06-13'; // a Saturday

  it('defaults to a rolling 30-day window ending today', () => {
    expect(resolveWindow({}, today)).toEqual({ from: '2026-05-15', to: '2026-06-13', range: '30d' });
  });

  it('7d → last 7 days', () => {
    expect(resolveWindow({ range: '7d' }, today)).toEqual({
      from: '2026-06-07',
      to: '2026-06-13',
      range: '7d',
    });
  });

  it('1y → last 365 days', () => {
    const w = resolveWindow({ range: '1y' }, today);
    expect(w).toEqual({ from: '2025-06-14', to: '2026-06-13', range: '1y' });
    expect(daySpanInclusive(w.from, w.to)).toBe(365);
  });

  it('rejects an unknown preset', () => {
    expect(() => resolveWindow({ range: 'bogus' }, today)).toThrow(BadRequestException);
  });
});

describe('resolveWindow (custom)', () => {
  const today = '2026-06-13';

  it('accepts a valid from→to and tags it custom', () => {
    expect(resolveWindow({ from: '2026-01-01', to: '2026-03-31' }, today)).toEqual({
      from: '2026-01-01',
      to: '2026-03-31',
      range: 'custom',
    });
  });

  it('clamps a future end down to today', () => {
    expect(resolveWindow({ from: '2026-06-01', to: '2099-01-01' }, today)).toEqual({
      from: '2026-06-01',
      to: '2026-06-13',
      range: 'custom',
    });
  });

  it('rejects when only one bound is given', () => {
    expect(() => resolveWindow({ from: '2026-01-01' }, today)).toThrow(BadRequestException);
    expect(() => resolveWindow({ to: '2026-01-01' }, today)).toThrow(BadRequestException);
  });

  it('rejects a malformed date', () => {
    expect(() => resolveWindow({ from: '2026-13-40', to: '2026-06-01' }, today)).toThrow(BadRequestException);
    expect(() => resolveWindow({ from: '01-01-2026', to: '2026-06-01' }, today)).toThrow(BadRequestException);
  });

  it('rejects an inverted range', () => {
    expect(() => resolveWindow({ from: '2026-06-10', to: '2026-06-01' }, today)).toThrow(BadRequestException);
  });

  it('rejects a range wider than the 2-year cap', () => {
    expect(() => resolveWindow({ from: '2020-01-01', to: '2026-06-13' }, today)).toThrow(BadRequestException);
  });

  it('accepts a range exactly at the cap', () => {
    // pick a [from, to] whose inclusive span == MAX_RANGE_DAYS
    const w = resolveWindow({ from: '2024-06-13', to: today }, today);
    expect(daySpanInclusive(w.from, w.to)).toBe(MAX_RANGE_DAYS);
    expect(w.range).toBe('custom');
  });
});

describe('isValidDay', () => {
  it('accepts real dates, rejects junk and impossible dates', () => {
    expect(isValidDay('2026-02-28')).toBe(true);
    expect(isValidDay('2026-02-29')).toBe(false); // 2026 not a leap year
    expect(isValidDay('2024-02-29')).toBe(true); // 2024 is
    expect(isValidDay('2026-6-1')).toBe(false);
    expect(isValidDay('nope')).toBe(false);
  });
});

describe('pickBucket', () => {
  it('day for short spans, week for medium, month for long', () => {
    expect(pickBucket('2026-06-07', '2026-06-13')).toBe('day'); // 7
    expect(pickBucket('2026-04-13', '2026-06-13')).toBe('day'); // 62
    expect(pickBucket('2026-04-12', '2026-06-13')).toBe('week'); // 63
    expect(pickBucket('2026-06-13', '2026-06-13')).toBe('day'); // 1 day
    expect(pickBucket('2025-06-13', '2026-06-13')).toBe('month'); // 366
  });
});

describe('buildAxis', () => {
  it('day → one key per day, inclusive, ascending', () => {
    const keys = buildAxis('day', '2026-06-07', '2026-06-13');
    expect(keys).toEqual([
      '2026-06-07',
      '2026-06-08',
      '2026-06-09',
      '2026-06-10',
      '2026-06-11',
      '2026-06-12',
      '2026-06-13',
    ]);
  });

  it('week → Monday keys covering the window, 7 days apart', () => {
    const keys = buildAxis('week', '2026-03-15', '2026-06-13'); // Sun → Sat
    expect(keys[0]).toBe('2026-03-09'); // Monday of the from-week
    expect(keys[keys.length - 1]).toBe('2026-06-08'); // Monday of the to-week
    for (const k of keys) {
      const [y, m, d] = k.split('-').map(Number);
      expect(new Date(Date.UTC(y, m - 1, d)).getUTCDay()).toBe(1);
    }
    for (let i = 1; i < keys.length; i++) {
      const a = Date.parse(`${keys[i - 1]}T00:00:00Z`);
      const b = Date.parse(`${keys[i]}T00:00:00Z`);
      expect((b - a) / 86_400_000).toBe(7);
    }
  });

  it('month → YYYY-MM keys covering the window', () => {
    const keys = buildAxis('month', '2025-07-15', '2026-06-13');
    expect(keys).toHaveLength(12);
    expect(keys[0]).toBe('2025-07');
    expect(keys[keys.length - 1]).toBe('2026-06');
  });

  it('handles the year boundary for month buckets', () => {
    const keys = buildAxis('month', '2025-02-10', '2026-01-09');
    expect(keys[0]).toBe('2025-02');
    expect(keys[keys.length - 1]).toBe('2026-01');
  });

  it('every bucket produces a non-empty ascending axis', () => {
    for (const [b, from, to] of [
      ['day', '2026-06-07', '2026-06-13'],
      ['week', '2026-03-15', '2026-06-13'],
      ['month', '2025-07-15', '2026-06-13'],
    ] as const) {
      const keys = buildAxis(b, from, to);
      expect(keys.length).toBeGreaterThan(0);
      expect(keys).toEqual([...keys].sort());
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
