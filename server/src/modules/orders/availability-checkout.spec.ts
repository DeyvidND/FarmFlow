import {
  decideDecrement,
  decideDecrementPooled,
  restoreRemaining,
} from '../availability/availability.util';

describe('decideDecrement', () => {
  it('no active window → allow, no decrement', () => {
    expect(decideDecrement(null, 3)).toEqual({ ok: true, newRemaining: null });
  });
  it('active window with enough stock → decrement', () => {
    expect(decideDecrement({ remaining: 5 }, 3)).toEqual({ ok: true, newRemaining: 2 });
  });
  it('active window with insufficient stock → reject', () => {
    expect(decideDecrement({ remaining: 2 }, 3)).toEqual({ ok: false, newRemaining: null });
  });
  it('exact stock → decrement to 0', () => {
    expect(decideDecrement({ remaining: 3 }, 3)).toEqual({ ok: true, newRemaining: 0 });
  });
});

describe('decideDecrementPooled', () => {
  it('no windows → allow, unlimited (unchanged no-stock-check behaviour)', () => {
    expect(decideDecrementPooled([], 3)).toEqual({ ok: true, newRemaining: null });
  });
  it('single exhausted window ("изчерпано") → reject, cannot order', () => {
    expect(decideDecrementPooled([{ remaining: 0 }], 1)).toEqual({ ok: false, newRemaining: null });
  });
  it('single window with enough stock → drain it', () => {
    expect(decideDecrementPooled([{ remaining: 5 }], 3)).toEqual({ ok: true, newRemaining: [2] });
  });
  it('all windows exhausted → reject even with several windows', () => {
    expect(decideDecrementPooled([{ remaining: 0 }, { remaining: 0 }], 1)).toEqual({
      ok: false,
      newRemaining: null,
    });
  });
  it('an exhausted window cannot be bypassed by a second window — pools the stock', () => {
    // 0 in the first window, 5 in the second → total 5 covers qty 3; drains first-then-second.
    expect(decideDecrementPooled([{ remaining: 0 }, { remaining: 5 }], 3)).toEqual({
      ok: true,
      newRemaining: [0, 2],
    });
  });
  it('drains across windows in order when one is insufficient alone', () => {
    expect(decideDecrementPooled([{ remaining: 2 }, { remaining: 2 }], 3)).toEqual({
      ok: true,
      newRemaining: [0, 1],
    });
  });
  it('pooled stock short → reject', () => {
    expect(decideDecrementPooled([{ remaining: 1 }, { remaining: 1 }], 3)).toEqual({
      ok: false,
      newRemaining: null,
    });
  });
});

describe('restoreRemaining', () => {
  it('adds qty back, capped at quantity', () => {
    expect(restoreRemaining({ quantity: 10, remaining: 4 }, 3)).toBe(7);
    expect(restoreRemaining({ quantity: 10, remaining: 9 }, 5)).toBe(10); // capped
  });
});
