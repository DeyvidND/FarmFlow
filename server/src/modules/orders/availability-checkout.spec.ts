import { decideDecrement, restoreRemaining } from '../availability/availability.util';

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

describe('restoreRemaining', () => {
  it('adds qty back, capped at quantity', () => {
    expect(restoreRemaining({ quantity: 10, remaining: 4 }, 3)).toBe(7);
    expect(restoreRemaining({ quantity: 10, remaining: 9 }, 5)).toBe(10); // capped
  });
});
