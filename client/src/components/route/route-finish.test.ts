import { describe, expect, it } from 'vitest';
import { nextUnfinishedId, nextUnfinishedAfter, resolveRemainingStart } from './route-finish';

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

describe('resolveRemainingStart', () => {
  const gps = { lat: 1, lng: 1 };
  const last = { lat: 2, lng: 2 };
  const saved = { lat: 3, lng: 3 };
  const base = { isDriver: false, finishedCount: 0, selfPos: null, lastFinished: null, persisted: null };

  it('prefers live GPS, then the last finished drop, then the persisted position', () => {
    expect(resolveRemainingStart({ ...base, isDriver: true, selfPos: gps, lastFinished: last, persisted: saved })).toEqual(gps);
    expect(resolveRemainingStart({ ...base, isDriver: true, lastFinished: last, persisted: saved })).toEqual(last);
    expect(resolveRemainingStart({ ...base, isDriver: true, persisted: saved })).toEqual(saved);
  });

  it('a driver anchors to the persisted position even before finishing anything this session (survives reload)', () => {
    // finishedCount 0 (fresh page), but a saved anchor from an earlier session.
    expect(resolveRemainingStart({ ...base, isDriver: true, finishedCount: 0, persisted: saved })).toEqual(saved);
  });

  it('a driver with no signal at all starts from the farm (null)', () => {
    expect(resolveRemainingStart({ ...base, isDriver: true })).toBeNull();
  });

  it('an operator does NOT anchor until a stop is finished this session (no farm→GPS drift)', () => {
    // Nothing finished this session → farm start, even if a stale persisted value exists.
    expect(resolveRemainingStart({ ...base, isDriver: false, finishedCount: 0, persisted: saved })).toBeNull();
    // Once they finish one this session, the last-finished anchor kicks in.
    expect(resolveRemainingStart({ ...base, isDriver: false, finishedCount: 1, lastFinished: last })).toEqual(last);
  });
});
