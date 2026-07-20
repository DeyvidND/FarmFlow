import { BadRequestException } from '@nestjs/common';
import {
  subtotalStotinki,
  recomputeTotalStotinki,
  assertOrderTotalWithinBounds,
  MAX_ORDER_TOTAL_STOTINKI,
} from './order-total.util';

describe('assertOrderTotalWithinBounds', () => {
  it('allows an ordinary order total', () => {
    expect(() => assertOrderTotalWithinBounds(0)).not.toThrow();
    expect(() => assertOrderTotalWithinBounds(4_599)).not.toThrow(); // 45.99
    expect(() => assertOrderTotalWithinBounds(MAX_ORDER_TOTAL_STOTINKI)).not.toThrow(); // boundary
  });

  it('rejects a total over the cap with a 400 (would otherwise 22003 int4-overflow the INSERT)', () => {
    // qty 10000 × 100 lines × a high unit price, or one expensive line, computes
    // fine in JS float64 but overflows the int4 total_stotinki column at INSERT.
    expect(() => assertOrderTotalWithinBounds(MAX_ORDER_TOTAL_STOTINKI + 1)).toThrow(BadRequestException);
    expect(() => assertOrderTotalWithinBounds(10_000_000_000)).toThrow(BadRequestException);
  });

  it('caps strictly below the int4 ceiling, so the guard fires before Postgres does', () => {
    // Postgres integer max is 2,147,483,647. The cap must sit under it so a value
    // that would overflow the column is rejected at the app edge, not by the DB.
    expect(MAX_ORDER_TOTAL_STOTINKI).toBeLessThan(2_147_483_647);
    expect(() => assertOrderTotalWithinBounds(2_100_000_000)).toThrow(BadRequestException);
  });

  it('rejects non-finite garbage (NaN / Infinity)', () => {
    expect(() => assertOrderTotalWithinBounds(Number.NaN)).toThrow(BadRequestException);
    expect(() => assertOrderTotalWithinBounds(Number.POSITIVE_INFINITY)).toThrow(BadRequestException);
  });
});

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
