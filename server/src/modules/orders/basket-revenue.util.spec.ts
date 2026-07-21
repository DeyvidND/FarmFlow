import { allocateBasketRevenue, allocateOrderRevenue } from './basket-revenue.util';

describe('allocateBasketRevenue', () => {
  it('splits proportionally to each child\'s (member price × quantity) weight', () => {
    // Parent 3990 stotinki. Tomatoes weight 2×200=400, cheese weight 1×600=600 → total 1000.
    // 3990 * 400/1000 = 1596, 3990 * 600/1000 = 2394. Divides evenly — no remainder to absorb.
    const shares = allocateBasketRevenue(3990, [
      { memberPriceStotinki: 200, quantity: 2 },
      { memberPriceStotinki: 600, quantity: 1 },
    ]);
    expect(shares).toEqual([1596, 2394]);
  });

  it('exact-sum invariant: the last child absorbs the rounding remainder', () => {
    // Parent 1000. Three equal-weight children → each 333.33 naively; floor gives
    // 333, 333, and the last must take 334 so the three sum to exactly 1000.
    const shares = allocateBasketRevenue(1000, [
      { memberPriceStotinki: 100, quantity: 1 },
      { memberPriceStotinki: 100, quantity: 1 },
      { memberPriceStotinki: 100, quantity: 1 },
    ]);
    expect(shares).toEqual([333, 333, 334]);
    expect(shares.reduce((a, b) => a + b, 0)).toBe(1000);
  });

  it('exact-sum invariant holds for arbitrary uneven weights (randomized check)', () => {
    // Deterministic pseudo-random scenarios — no DB, no mocks; just the arithmetic
    // invariant the whole allocation rule exists to guarantee.
    let seed = 42;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed;
    };
    for (let trial = 0; trial < 50; trial++) {
      const parentTotal = 100 + (rand() % 50_000);
      const n = 1 + (rand() % 6);
      const children = Array.from({ length: n }, () => ({
        memberPriceStotinki: 1 + (rand() % 5_000),
        quantity: 1 + (rand() % 5),
      }));
      const shares = allocateBasketRevenue(parentTotal, children);
      expect(shares.reduce((a, b) => a + b, 0)).toBe(parentTotal);
      // No share should be negative — floors of positive weights can't overshoot,
      // and the remainder given to the last should never drive it negative as
      // long as the floors never exceed the parent total (they can't: each floor
      // ≤ its own proportional share of the total).
      for (const s of shares) expect(s).toBeGreaterThanOrEqual(0);
    }
  });

  it('a single-child basket assigns the child the FULL parent total', () => {
    const shares = allocateBasketRevenue(3990, [{ memberPriceStotinki: 1, quantity: 1 }]);
    expect(shares).toEqual([3990]);
  });

  it('a single-child basket gets the full total even priced at 0 (degenerate weight)', () => {
    const shares = allocateBasketRevenue(1500, [{ memberPriceStotinki: 0, quantity: 3 }]);
    expect(shares).toEqual([1500]);
  });

  it('a zero-price member (not last) contributes zero weight and earns 0', () => {
    const shares = allocateBasketRevenue(2000, [
      { memberPriceStotinki: 0, quantity: 5 }, // a free add-on member, no weight
      { memberPriceStotinki: 400, quantity: 5 }, // the only real weight — gets it all
    ]);
    expect(shares).toEqual([0, 2000]);
  });

  it('returns an empty array for a childless call', () => {
    expect(allocateBasketRevenue(1000, [])).toEqual([]);
  });
});

describe('allocateOrderRevenue', () => {
  it('leaves ordinary lines (no bundleParentId) at their stored price × quantity', () => {
    const rev = allocateOrderRevenue([
      { id: 'a', bundleParentId: null, quantity: 3, priceStotinki: 250, memberPriceStotinki: 250 },
    ]);
    expect(rev.get('a')).toBe(750);
  });

  it('allocates a basket parent+children order: parent keeps its own price, children split it', () => {
    const rev = allocateOrderRevenue([
      { id: 'parent', bundleParentId: null, quantity: 1, priceStotinki: 3990, memberPriceStotinki: 3990 },
      { id: 'tomato', bundleParentId: 'parent', quantity: 2, priceStotinki: 0, memberPriceStotinki: 200 },
      { id: 'cheese', bundleParentId: 'parent', quantity: 1, priceStotinki: 0, memberPriceStotinki: 600 },
    ]);
    expect(rev.get('parent')).toBe(3990); // the parent's OWN line is untouched
    expect(rev.get('tomato')).toBe(1596); // 3990 * 400/1000
    expect(rev.get('cheese')).toBe(2394); // remainder
    // The children's shares alone (excluding the parent) sum to the parent's total —
    // this is what makes summing a farmer's OWN children not double- or under-count.
    expect((rev.get('tomato') ?? 0) + (rev.get('cheese') ?? 0)).toBe(3990);
  });

  it('is order-of-input independent — the same child always absorbs the remainder', () => {
    const items = [
      { id: 'parent', bundleParentId: null, quantity: 1, priceStotinki: 1000, memberPriceStotinki: 1000 },
      { id: 'child-b', bundleParentId: 'parent', quantity: 1, priceStotinki: 0, memberPriceStotinki: 100 },
      { id: 'child-a', bundleParentId: 'parent', quantity: 1, priceStotinki: 0, memberPriceStotinki: 100 },
      { id: 'child-c', bundleParentId: 'parent', quantity: 1, priceStotinki: 0, memberPriceStotinki: 100 },
    ];
    const forward = allocateOrderRevenue(items);
    const shuffled = allocateOrderRevenue([...items].reverse());
    expect(forward.get('child-a')).toBe(shuffled.get('child-a'));
    expect(forward.get('child-b')).toBe(shuffled.get('child-b'));
    expect(forward.get('child-c')).toBe(shuffled.get('child-c'));
  });

  it('skips an orphaned child row (bundleParentId points at nothing in the set)', () => {
    const rev = allocateOrderRevenue([
      { id: 'orphan', bundleParentId: 'missing-parent', quantity: 1, priceStotinki: 0, memberPriceStotinki: 500 },
    ]);
    expect(rev.has('orphan')).toBe(false);
  });
});
