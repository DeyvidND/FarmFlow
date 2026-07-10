import { describe, expect, it } from 'vitest';
import { nextUnfinishedId } from './route-finish';

const stops = (...ids: string[]) => ids.map((id) => ({ id }));

describe('nextUnfinishedId', () => {
  it('returns the first stop when none are finished', () => {
    expect(nextUnfinishedId(stops('a', 'b', 'c'), new Set())).toBe('a');
  });

  it('skips finished stops and returns the next one', () => {
    expect(nextUnfinishedId(stops('a', 'b', 'c'), new Set(['a']))).toBe('b');
    expect(nextUnfinishedId(stops('a', 'b', 'c'), new Set(['a', 'b']))).toBe('c');
  });

  it('respects the given stop order, not the set order', () => {
    expect(nextUnfinishedId(stops('c', 'a', 'b'), new Set(['c']))).toBe('a');
  });

  it('returns null when every stop is finished', () => {
    expect(nextUnfinishedId(stops('a', 'b'), new Set(['a', 'b']))).toBeNull();
  });

  it('returns null when there are no stops', () => {
    expect(nextUnfinishedId([], new Set())).toBeNull();
  });
});
