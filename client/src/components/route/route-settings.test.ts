import { describe, expect, it } from 'vitest';
import { clampPos } from './route-settings';

describe('clampPos', () => {
  it('leaves an in-range position unchanged', () => {
    expect(clampPos(1, 3)).toBe(1);
    expect(clampPos(0, 1)).toBe(0);
  });

  it('pulls a stale position back into range when the courier count shrinks', () => {
    // The drawer stores the pager position in state and stays mounted across a
    // soft-nav that lowers the courier count (the „Раздели маршрута на" control
    // pushes ?couriers=1 without remounting). endPos then points past the last
    // courier; every read must clamp, or onSetEndAt fires an out-of-range index
    // the parent's routes.map matches nothing → the end-mode toggle silently
    // no-ops. Was on courier 2 of 2 (pos 1), now only 1 courier → pos 0.
    expect(clampPos(1, 1)).toBe(0);
    expect(clampPos(5, 2)).toBe(1);
  });

  it('never returns negative, even with zero couriers', () => {
    expect(clampPos(0, 0)).toBe(0);
    expect(clampPos(3, 0)).toBe(0);
  });
});
