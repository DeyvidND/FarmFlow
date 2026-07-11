// server/src/modules/digest/digest-range.spec.ts
import { __rangeInternals } from './digest.service';

const { assembleFarmerRangeEmail } = __rangeInternals;

const row = (over: Partial<Record<string, unknown>> = {}) => ({
  orderId: 'o1',
  deliveryType: 'address',
  customerName: 'Иван',
  deliveryAddress: 'ул. Роза 5',
  deliveryCity: 'София',
  econtOffice: null,
  slotFrom: '09:00:00',
  slotTo: '12:00:00',
  productName: 'Домати',
  quantity: 3,
  ...over,
});

describe('assembleFarmerRangeEmail', () => {
  it('returns null when every day is empty', () => {
    const res = assembleFarmerRangeEmail('2026-07-10', '2026-07-12', 'Иван', new Map());
    expect(res).toBeNull();
  });

  it('renders one section per non-empty day and skips empty days', () => {
    const byDay = new Map<string, any[]>([
      ['2026-07-10', [row({ orderId: 'a' })]],
      ['2026-07-11', []],
      ['2026-07-12', [row({ orderId: 'b', customerName: 'Мария' })]],
    ]);
    const res = assembleFarmerRangeEmail('2026-07-10', '2026-07-12', 'Иван', byDay)!;
    expect(res).not.toBeNull();
    // Both non-empty days present; the empty middle day is not.
    expect(res.html).toContain('2026-07-10');
    expect(res.html).toContain('2026-07-12');
    expect(res.html.match(/2026-07-11/g)).toBeNull();
    // Single wrapping document, not concatenated docs.
    expect(res.html.match(/<!DOCTYPE html>/g)!.length).toBe(1);
    expect(res.html).toContain('Иван'); // farmer name in header
    expect(res.text).toContain('Домати');
  });
});
