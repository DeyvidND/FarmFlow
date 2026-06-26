import { cheapestVariantPrice, planVariantWrites } from './products.service';

describe('cheapestVariantPrice', () => {
  it('returns null for no variants', () => {
    expect(cheapestVariantPrice([])).toBeNull();
  });
  it('returns the minimum priceStotinki', () => {
    expect(cheapestVariantPrice([{ priceStotinki: 1250 }, { priceStotinki: 650 }])).toBe(650);
  });
});

describe('planVariantWrites', () => {
  it('splits incoming variants into inserts (no id) and updates (with id), and finds deletions', () => {
    const incoming = [
      { label: 'Нов 1кг', priceStotinki: 1200 },
      { id: 'v1', label: 'Стар 500г', priceStotinki: 650, stockQuantity: 5 },
    ];
    const existingIds = ['v1', 'v2'];
    const plan = planVariantWrites(incoming, existingIds);
    expect(plan.inserts).toEqual([{ label: 'Нов 1кг', priceStotinki: 1200, position: 0 }]);
    expect(plan.updates).toEqual([
      { id: 'v1', label: 'Стар 500г', priceStotinki: 650, stockQuantity: 5, position: 1 },
    ]);
    expect(plan.deleteIds).toEqual(['v2']); // existing but not in incoming
  });
});
