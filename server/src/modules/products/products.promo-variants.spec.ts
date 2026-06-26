import { buildPublicProduct, cheapestVariantPrice, planVariantWrites, variantsHaveFixedSale } from './products.service';

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

  it('carries a per-variant fixed promo price (including null to clear it)', () => {
    const plan = planVariantWrites(
      [
        { id: 'v1', label: 'A', priceStotinki: 1000, salePriceStotinki: 800 },
        { id: 'v2', label: 'B', priceStotinki: 600, salePriceStotinki: null },
      ],
      ['v1', 'v2'],
    );
    expect(plan.updates[0]).toMatchObject({ id: 'v1', salePriceStotinki: 800 });
    expect(plan.updates[1]).toMatchObject({ id: 'v2', salePriceStotinki: null });
  });
});

describe('variantsHaveFixedSale', () => {
  it('is false for undefined / none set', () => {
    expect(variantsHaveFixedSale(undefined)).toBe(false);
    expect(variantsHaveFixedSale([{ label: 'A', priceStotinki: 100 }])).toBe(false);
    expect(variantsHaveFixedSale([{ label: 'A', priceStotinki: 100, salePriceStotinki: null }])).toBe(false);
  });
  it('is true when any variant carries a fixed promo price', () => {
    expect(
      variantsHaveFixedSale([
        { label: 'A', priceStotinki: 100 },
        { label: 'B', priceStotinki: 200, salePriceStotinki: 150 },
      ]),
    ).toBe(true);
  });
});

const baseProduct = {
  id: 'p1', tenantId: 't1', name: 'Мед', slug: 'med', description: null,
  priceStotinki: 650, unit: 'бр', weight: null, category: null, tint: null,
  stockQuantity: 0, isActive: true, imageUrl: null, coverCrop: null,
  farmerId: null, subcategoryId: null, stripeProductId: null, stripePriceId: null,
  bundleItems: null, compareAtPriceStotinki: null, featured: false, position: 0,
  deletedAt: null, createdAt: new Date(), salePercent: null, saleEndsAt: null,
} as any;
const NOW2 = new Date('2026-06-26T10:00:00Z');

describe('buildPublicProduct', () => {
  it('strips private fields and defaults variants to []', () => {
    const pub = buildPublicProduct(baseProduct, [], [], NOW2);
    expect(pub).not.toHaveProperty('tenantId');
    expect(pub).not.toHaveProperty('stockQuantity');
    expect(pub.variants).toEqual([]);
    expect(pub.salePriceStotinki).toBeUndefined();
  });

  it('adds discounted prices to base + each variant when promo active', () => {
    const variants = [
      { id: 'v1', label: '500г', priceStotinki: 650, stockQuantity: 3 },
      { id: 'v2', label: '1кг', priceStotinki: 1250, stockQuantity: 0 },
    ] as any;
    const pub = buildPublicProduct({ ...baseProduct, salePercent: 20 }, [], variants, NOW2);
    expect(pub.salePriceStotinki).toBe(520);
    expect(pub.variants[0]).toEqual({ id: 'v1', label: '500г', priceStotinki: 650, salePriceStotinki: 520, soldOut: false });
    expect(pub.variants[1]).toEqual({ id: 'v2', label: '1кг', priceStotinki: 1250, salePriceStotinki: 1000, soldOut: true });
  });

  it('omits sale prices when promo expired', () => {
    const pub = buildPublicProduct({ ...baseProduct, salePercent: 20, saleEndsAt: new Date('2026-06-01') }, [], [], NOW2);
    expect(pub.salePriceStotinki).toBeUndefined();
  });

  it('uses a per-variant fixed promo price (no product %)', () => {
    const variants = [
      { id: 'v1', label: '500г', priceStotinki: 650, salePriceStotinki: 500, stockQuantity: 3 },
      { id: 'v2', label: '1кг', priceStotinki: 1250, salePriceStotinki: null, stockQuantity: 2 },
    ] as any;
    const pub = buildPublicProduct(baseProduct, [], variants, NOW2);
    expect(pub.salePriceStotinki).toBeUndefined(); // no product-level promo
    expect(pub.variants[0]).toEqual({ id: 'v1', label: '500г', priceStotinki: 650, salePriceStotinki: 500, soldOut: false });
    expect(pub.variants[1]).toEqual({ id: 'v2', label: '1кг', priceStotinki: 1250, soldOut: false }); // no fixed promo
  });

  it("variant's own fixed promo wins over the product %", () => {
    const variants = [
      { id: 'v1', label: '500г', priceStotinki: 650, salePriceStotinki: 500, stockQuantity: 3 },
      { id: 'v2', label: '1кг', priceStotinki: 1000, salePriceStotinki: null, stockQuantity: 1 },
    ] as any;
    // (writes keep these exclusive, but a defensive read still prefers the fixed price)
    const pub = buildPublicProduct({ ...baseProduct, salePercent: 20 }, [], variants, NOW2);
    expect(pub.variants[0].salePriceStotinki).toBe(500); // fixed, not 520 (20% of 650)
    expect(pub.variants[1].salePriceStotinki).toBe(800); // falls back to product 20%
  });
});
