import { subtotalStotinki, recomputeTotalStotinki } from './order-total.util';

describe('subtotalStotinki', () => {
  it('sums quantity × unit price', () => {
    expect(
      subtotalStotinki([
        { quantity: 2, priceStotinki: 500 },
        { quantity: 1, priceStotinki: 350 },
      ]),
    ).toBe(1350);
  });
  it('empty cart → 0', () => {
    expect(subtotalStotinki([])).toBe(0);
  });
});

describe('recomputeTotalStotinki', () => {
  it('preserves the folded-in delivery fee', () => {
    // prev: subtotal 1000 + fee 300 = 1300; new subtotal 1200 → 1200 + 300
    expect(recomputeTotalStotinki(1300, 1000, 1200)).toBe(1500);
  });
  it('no fee (subtotal == total) carries nothing extra', () => {
    expect(recomputeTotalStotinki(1000, 1000, 400)).toBe(400);
  });
  it('never treats a negative gap as a fee (clamps to 0)', () => {
    // Legacy/odd row where total < subtotal — do not add a negative fee.
    expect(recomputeTotalStotinki(900, 1000, 500)).toBe(500);
  });
});
