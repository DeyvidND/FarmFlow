/**
 * Unit test for the `courierShippable` flag in the public storefront shape
 * (buildPublicProduct — see products.service.ts). It's a positive alias for
 * `!courierDisabled`: true = may go on an Econt/Speedy waybill, false =
 * pickup/local only. Mirrors the product-row shape used by
 * products.promo-variants.spec.ts's `baseProduct`.
 */
import { buildPublicProduct } from './products.service';

const baseProduct = {
  id: 'p1', tenantId: 't1', name: 'Мед', slug: 'med', description: null,
  priceStotinki: 650, unit: 'бр', weight: null, category: null, tint: null,
  stockQuantity: 0, isActive: true, imageUrl: null, coverCrop: null,
  farmerId: null, subcategoryId: null, stripeProductId: null, stripePriceId: null,
  bundleItems: null, compareAtPriceStotinki: null, featured: false, position: 0,
  deletedAt: null, createdAt: new Date(), salePercent: null, saleEndsAt: null,
  courierDisabled: false,
} as any;
const NOW = new Date('2026-06-26T10:00:00Z');

describe('buildPublicProduct — courierShippable', () => {
  it('is true when courierDisabled is false', () => {
    const pub = buildPublicProduct({ ...baseProduct, courierDisabled: false }, [], [], NOW);
    expect(pub.courierShippable).toBe(true);
  });

  it('is false when courierDisabled is true', () => {
    const pub = buildPublicProduct({ ...baseProduct, courierDisabled: true }, [], [], NOW);
    expect(pub.courierShippable).toBe(false);
  });
});
