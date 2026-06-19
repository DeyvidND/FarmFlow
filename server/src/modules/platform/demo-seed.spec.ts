import { DEMO_SEED } from './demo-seed';

describe('DEMO_SEED', () => {
  it('has 3 categories, 2 farmers and 8 products', () => {
    expect(DEMO_SEED.categories).toHaveLength(3);
    expect(DEMO_SEED.farmers).toHaveLength(2);
    expect(DEMO_SEED.products).toHaveLength(8);
  });

  it('every product has an integer price, a unit and a non-negative stock', () => {
    for (const p of DEMO_SEED.products) {
      expect(Number.isInteger(p.priceStotinki)).toBe(true);
      expect(p.priceStotinki).toBeGreaterThan(0);
      expect(typeof p.unit).toBe('string');
      expect(p.stock).toBeGreaterThanOrEqual(0);
    }
  });
});
