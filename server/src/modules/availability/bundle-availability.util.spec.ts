import { basketRemaining } from './bundle-availability.util';

const live = new Set(['p1', 'p2']);

describe('basketRemaining', () => {
  it('is the smallest member cap', () => {
    const rem = new Map([['p1', 10], ['p2', 3]]);
    expect(basketRemaining([{ productId: 'p1', quantity: 1 }, { productId: 'p2', quantity: 1 }], rem, live)).toBe(3);
  });

  it('divides by how many of that member go in one basket', () => {
    const rem = new Map([['p1', 7]]);
    expect(basketRemaining([{ productId: 'p1', quantity: 2 }], rem, new Set(['p1']))).toBe(3);
  });

  it('treats a member with no window as unlimited', () => {
    const rem = new Map([['p2', 4]]);
    expect(basketRemaining([{ productId: 'p1', quantity: 1 }, { productId: 'p2', quantity: 1 }], rem, live)).toBe(4);
  });

  it('is unlimited when no member has a window', () => {
    expect(basketRemaining([{ productId: 'p1', quantity: 1 }], new Map(), new Set(['p1']))).toBeNull();
  });

  it('is sold out when a member is not live', () => {
    const rem = new Map([['p1', 10], ['p9', 10]]);
    expect(basketRemaining([{ productId: 'p9', quantity: 1 }], rem, live)).toBe(0);
  });

  it('is sold out with no members at all', () => {
    expect(basketRemaining([], new Map(), live)).toBe(0);
  });

  it('is sold out when a member has zero remaining', () => {
    const rem = new Map([['p1', 0]]);
    expect(basketRemaining([{ productId: 'p1', quantity: 1 }], rem, new Set(['p1']))).toBe(0);
  });
});
