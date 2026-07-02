import { resolveLineUnit, requiresVariantSelection } from './orders.service';

const NOW = new Date('2026-06-26T10:00:00Z');
const product = { priceStotinki: 1000, name: 'Мед', weight: '1кг', salePercent: null, saleEndsAt: null } as any;

describe('resolveLineUnit', () => {
  it('uses product price + name when no variant', () => {
    expect(resolveLineUnit(product, null, NOW)).toEqual({
      unitStotinki: 1000,
      label: 'Мед 1кг',
      variantId: null,
      variantLabel: null,
    });
  });

  it('uses the variant price + label when a variant is given', () => {
    const variant = { id: 'v1', label: 'Кристализиран 500г', priceStotinki: 650, stockQuantity: 5 } as any;
    expect(resolveLineUnit(product, variant, NOW)).toEqual({
      unitStotinki: 650,
      label: 'Мед Кристализиран 500г',
      variantId: 'v1',
      variantLabel: 'Кристализиран 500г',
    });
  });

  it('applies an active promo to the variant price', () => {
    const variant = { id: 'v1', label: '500г', priceStotinki: 650, salePriceStotinki: null, stockQuantity: 5 } as any;
    const res = resolveLineUnit({ ...product, salePercent: 20 }, variant, NOW);
    expect(res.unitStotinki).toBe(520);
  });

  it("charges a variant's own fixed promo price (matches the storefront)", () => {
    const variant = { id: 'v1', label: '500г', priceStotinki: 650, salePriceStotinki: 500, stockQuantity: 5 } as any;
    const res = resolveLineUnit(product, variant, NOW);
    expect(res.unitStotinki).toBe(500);
  });

  it("a variant's fixed promo wins over the product % (defensive read)", () => {
    const variant = { id: 'v1', label: '500г', priceStotinki: 650, salePriceStotinki: 500, stockQuantity: 5 } as any;
    const res = resolveLineUnit({ ...product, salePercent: 20 }, variant, NOW);
    expect(res.unitStotinki).toBe(500); // fixed 500, not 520
  });

  it('charges a plain product its product-level fixed promo price', () => {
    const res = resolveLineUnit({ ...product, salePriceStotinki: 800 }, null, NOW);
    expect(res.unitStotinki).toBe(800);
  });

  it('product-level fixed price wins over the % for a plain line', () => {
    // price 1000, % would give 800; the fixed 750 must win.
    const res = resolveLineUnit({ ...product, salePercent: 20, salePriceStotinki: 750 }, null, NOW);
    expect(res.unitStotinki).toBe(750);
  });
});

describe('requiresVariantSelection', () => {
  it('rejects a line that omits variantId for a varianted product', () => {
    expect(requiresVariantSelection(true, undefined)).toBe(true);
  });

  it('accepts a varianted product when a variant is chosen', () => {
    expect(requiresVariantSelection(true, 'v1')).toBe(false);
  });

  it('accepts a product with no variants regardless of variantId', () => {
    expect(requiresVariantSelection(false, undefined)).toBe(false);
    expect(requiresVariantSelection(false, 'v1')).toBe(false);
  });
});
