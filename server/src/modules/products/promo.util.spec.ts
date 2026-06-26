import { isPromoActive, salePriceStotinki, effectivePriceStotinki } from './promo.util';

const NOW = new Date('2026-06-26T10:00:00Z');

describe('isPromoActive', () => {
  it('false when no percent', () => {
    expect(isPromoActive(null, null, NOW)).toBe(false);
    expect(isPromoActive(null, new Date('2030-01-01'), NOW)).toBe(false);
  });
  it('true when percent set and no end date', () => {
    expect(isPromoActive(20, null, NOW)).toBe(true);
  });
  it('true when end date is in the future', () => {
    expect(isPromoActive(20, new Date('2026-07-31T00:00:00Z'), NOW)).toBe(true);
  });
  it('false when end date has passed', () => {
    expect(isPromoActive(20, new Date('2026-06-25T00:00:00Z'), NOW)).toBe(false);
  });
});

describe('salePriceStotinki', () => {
  it('rounds price * (1 - pct/100)', () => {
    expect(salePriceStotinki(650, 20)).toBe(520); // 650 * 0.8
    expect(salePriceStotinki(1250, 20)).toBe(1000);
    expect(salePriceStotinki(999, 33)).toBe(669); // 999*0.67=669.33 → 669
  });
});

describe('effectivePriceStotinki', () => {
  it('returns discounted price when promo active', () => {
    expect(effectivePriceStotinki(650, 20, null, NOW)).toBe(520);
  });
  it('returns the regular price when promo inactive/expired', () => {
    expect(effectivePriceStotinki(650, null, null, NOW)).toBe(650);
    expect(effectivePriceStotinki(650, 20, new Date('2026-06-25'), NOW)).toBe(650);
  });
});
