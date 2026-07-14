import { describe, expect, it } from 'vitest';
import { computeCompleteness } from './completeness-meter';

describe('computeCompleteness', () => {
  const base = {
    hasPhoto: true, hasBio: true, hasStory: false, hasProducts: false,
    hasAccess: false, marketplace: false, hasLegal: false, hasPayout: false,
  };

  it('single-farm tenant has 5 items', () => {
    expect(computeCompleteness(base)).toHaveLength(5);
  });

  it('marketplace tenant adds legal + payout (7 items)', () => {
    expect(computeCompleteness({ ...base, marketplace: true })).toHaveLength(7);
  });

  it('marks done from the input flags', () => {
    const items = computeCompleteness(base);
    expect(items.find((x) => x.key === 'photo')?.done).toBe(true);
    expect(items.find((x) => x.key === 'story')?.done).toBe(false);
  });
});
