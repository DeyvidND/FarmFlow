import { resolveProductOfWeek } from './product-of-week';

const PRODUCTS = [{ id: 'p0' }, { id: 'p1' }, { id: 'p2' }];
const NOW = new Date('2026-06-09'); // ISO week 24

describe('resolveProductOfWeek', () => {
  it('returns null when the highlight is disabled', () => {
    expect(
      resolveProductOfWeek(
        { productOfWeekEnabled: false, productOfWeekMode: 'manual', productOfWeekId: 'p1' },
        PRODUCTS,
        NOW,
      ),
    ).toBeNull();
  });

  it('returns null when there are no active products', () => {
    expect(
      resolveProductOfWeek({ productOfWeekEnabled: true, productOfWeekMode: 'auto' }, [], NOW),
    ).toBeNull();
  });

  it('manual mode returns the picked product with its note', () => {
    expect(
      resolveProductOfWeek(
        {
          productOfWeekEnabled: true,
          productOfWeekMode: 'manual',
          productOfWeekId: 'p2',
          productOfWeekNote: 'Сезонна ягода',
        },
        PRODUCTS,
        NOW,
      ),
    ).toEqual({ id: 'p2', note: 'Сезонна ягода' });
  });

  it('manual mode returns null when the picked product is not in the active list', () => {
    expect(
      resolveProductOfWeek(
        { productOfWeekEnabled: true, productOfWeekMode: 'manual', productOfWeekId: 'gone' },
        PRODUCTS,
        NOW,
      ),
    ).toBeNull();
  });

  it('auto mode rotates by ISO week (week 24 % 3 = 0 → first product)', () => {
    expect(
      resolveProductOfWeek({ productOfWeekEnabled: true, productOfWeekMode: 'auto' }, PRODUCTS, NOW),
    ).toEqual({ id: 'p0', note: null });
  });
});
