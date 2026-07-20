import { describe, it, expect } from 'vitest';
import { applyConfirmAll, markDelivered } from './today-logic';
import type { TodayPipeline } from '@/lib/types';

const P: TodayPipeline = { new: 2, confirmed: 1, preparing: 0, outForDelivery: 0, delivered: 3, cancelled: 0, total: 6 };

describe('today-logic', () => {
  it('applyConfirmAll moves new into confirmed and zeroes new', () => {
    expect(applyConfirmAll(P)).toMatchObject({ new: 0, confirmed: 3, delivered: 3, total: 6 });
  });

  it('applyConfirmAll does not mutate the input', () => {
    const copy = { ...P };
    applyConfirmAll(P);
    expect(P).toEqual(copy);
  });

  it('markDelivered moves one order from its bucket to delivered', () => {
    expect(markDelivered(P, 'confirmed')).toMatchObject({ confirmed: 0, delivered: 4 });
  });

  it('markDelivered keeps total unchanged and clamps the source bucket at 0', () => {
    const out = markDelivered(P, 'preparing'); // preparing is already 0
    expect(out.preparing).toBe(0);
    expect(out.delivered).toBe(4);
    expect(out.total).toBe(P.total);
  });

  it('markDelivered from outForDelivery decrements that bucket', () => {
    const src: TodayPipeline = { ...P, outForDelivery: 2, total: 8 };
    const out = markDelivered(src, 'outForDelivery');
    expect(out.outForDelivery).toBe(1);
    expect(out.delivered).toBe(4);
  });
});
