import { describe, expect, it } from 'vitest';
import { groupBySourceDay } from './add-orders';
import type { ReschedulableOrder } from '@/lib/types';

const order = (id: string, slotDate: string, overrides: Partial<ReschedulableOrder> = {}): ReschedulableOrder => ({
  id,
  orderNumber: null,
  customerName: null,
  customerPhone: null,
  totalStotinki: 0,
  status: 'confirmed',
  slotDate,
  ...overrides,
});

describe('groupBySourceDay', () => {
  it('excludes rows whose slotDate matches the route date', () => {
    const rows = [order('a', '2026-07-15'), order('b', '2026-07-16')];
    const groups = groupBySourceDay(rows, '2026-07-15');
    expect(groups).toEqual([{ date: '2026-07-16', orders: [rows[1]] }]);
  });

  it('groups rows by slotDate', () => {
    const rows = [order('a', '2026-07-16'), order('b', '2026-07-17'), order('c', '2026-07-16')];
    const groups = groupBySourceDay(rows, '2026-07-15');
    expect(groups).toEqual([
      { date: '2026-07-16', orders: [rows[0], rows[2]] },
      { date: '2026-07-17', orders: [rows[1]] },
    ]);
  });

  it('sorts groups ascending by date', () => {
    const rows = [order('a', '2026-07-20'), order('b', '2026-07-16'), order('c', '2026-07-18')];
    const groups = groupBySourceDay(rows, '2026-07-15');
    expect(groups.map((g) => g.date)).toEqual(['2026-07-16', '2026-07-18', '2026-07-20']);
  });

  it('returns an empty array for empty input', () => {
    expect(groupBySourceDay([], '2026-07-15')).toEqual([]);
  });

  it('returns an empty array when every row is already on the route date', () => {
    const rows = [order('a', '2026-07-15'), order('b', '2026-07-15')];
    expect(groupBySourceDay(rows, '2026-07-15')).toEqual([]);
  });
});
