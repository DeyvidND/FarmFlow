import { describe, expect, it } from 'vitest';
import { nextUnfinishedId, nextUnfinishedAfter } from './route-finish';

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

describe('nextUnfinishedAfter', () => {
  it('advances to the stop right after the finished one', () => {
    expect(nextUnfinishedAfter(stops('a', 'b', 'c'), new Set(['a']), 'a')).toBe('b');
    expect(nextUnfinishedAfter(stops('a', 'b', 'c'), new Set(['b']), 'b')).toBe('c');
  });

  it('skips finished stops after the pivot', () => {
    expect(nextUnfinishedAfter(stops('a', 'b', 'c', 'd'), new Set(['b', 'c']), 'b')).toBe('d');
  });

  it('wraps to the top when the finished stop was last', () => {
    expect(nextUnfinishedAfter(stops('a', 'b', 'c'), new Set(['c']), 'c')).toBe('a');
    // Mid-route pick: finishing "c" with "d" also done wraps past the end to "a".
    expect(nextUnfinishedAfter(stops('a', 'b', 'c', 'd'), new Set(['c', 'd']), 'c')).toBe('a');
  });

  it('returns null when every stop is finished', () => {
    expect(nextUnfinishedAfter(stops('a', 'b'), new Set(['a', 'b']), 'a')).toBeNull();
  });

  it('falls back to the first unfinished stop for an unknown pivot', () => {
    expect(nextUnfinishedAfter(stops('a', 'b'), new Set(['a']), 'zz')).toBe('b');
  });

  it('handles an empty list', () => {
    expect(nextUnfinishedAfter([], new Set(), 'a')).toBeNull();
  });
});
