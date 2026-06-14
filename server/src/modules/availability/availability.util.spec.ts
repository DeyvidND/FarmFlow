import { activeWindow, rangesOverlap, applyQuantityDelta } from './availability.util';

type W = { id: string; startsAt: string; endsAt: string; quantity: number; remaining: number };
const w = (id: string, startsAt: string, endsAt: string, remaining = 5, quantity = 5): W =>
  ({ id, startsAt, endsAt, quantity, remaining });

describe('activeWindow', () => {
  it('returns the window covering today (inclusive bounds)', () => {
    const list = [w('a', '2026-06-01', '2026-06-10'), w('b', '2026-06-14', '2026-06-20')];
    expect(activeWindow(list, '2026-06-14')?.id).toBe('b');
    expect(activeWindow(list, '2026-06-20')?.id).toBe('b');
    expect(activeWindow(list, '2026-06-01')?.id).toBe('a');
  });
  it('returns null when no window covers today', () => {
    expect(activeWindow([w('a', '2026-06-01', '2026-06-10')], '2026-06-13')).toBeNull();
  });
  it('returns null for an empty list', () => {
    expect(activeWindow([], '2026-06-14')).toBeNull();
  });
});

describe('rangesOverlap', () => {
  it('detects overlapping inclusive ranges', () => {
    expect(rangesOverlap('2026-06-01', '2026-06-10', '2026-06-10', '2026-06-12')).toBe(true);
    expect(rangesOverlap('2026-06-01', '2026-06-10', '2026-06-11', '2026-06-12')).toBe(false);
  });
  it('returns false when A is entirely before B', () => {
    expect(rangesOverlap('2026-06-01', '2026-06-05', '2026-06-10', '2026-06-20')).toBe(false);
  });
  it('returns false when B is entirely before A (symmetry)', () => {
    expect(rangesOverlap('2026-06-10', '2026-06-20', '2026-06-01', '2026-06-05')).toBe(false);
  });
  it('returns true when A contains B', () => {
    expect(rangesOverlap('2026-06-01', '2026-06-20', '2026-06-05', '2026-06-10')).toBe(true);
  });
  it('returns true for a single-day touch (same date)', () => {
    expect(rangesOverlap('2026-06-10', '2026-06-10', '2026-06-10', '2026-06-10')).toBe(true);
  });
});

describe('applyQuantityDelta', () => {
  it('shifts remaining by the quantity delta, floored at amount already sold', () => {
    // sold = quantity - remaining = 10 - 4 = 6. New quantity 8 → remaining 8-6 = 2.
    expect(applyQuantityDelta({ quantity: 10, remaining: 4 }, 8)).toBe(2);
    // Lowering below sold floors remaining at 0 (can't un-sell).
    expect(applyQuantityDelta({ quantity: 10, remaining: 4 }, 5)).toBe(0);
    // Raising quantity adds headroom.
    expect(applyQuantityDelta({ quantity: 10, remaining: 4 }, 15)).toBe(9);
  });
});
