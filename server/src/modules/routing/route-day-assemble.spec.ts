import { assembleDaySuggestion } from './route-day-assemble';
import type { ReschedulableOrder } from '../orders/orders.service';

const depot = { lat: 42.65, lng: 23.32 };
const mk = (
  id: string,
  lat: number | null,
  lng: number | null,
  overrides: Partial<ReschedulableOrder> = {},
): ReschedulableOrder => ({
  id,
  orderNumber: Number(id.replace(/\D/g, '')) || null,
  customerName: `C${id}`,
  customerPhone: null,
  totalStotinki: 1000,
  status: 'confirmed',
  slotDate: '2026-07-10',
  deliveryLat: lat == null ? null : String(lat),
  deliveryLng: lng == null ? null : String(lng),
  ...overrides,
});

describe('assembleDaySuggestion (couriers + time + reason)', () => {
  it('echoes the requested courier count even when there are fewer routes', () => {
    const pool = [mk('1', 42.71, 23.32)];
    const res = assembleDaySuggestion(pool, new Map(), depot, [{ date: '2026-07-10', couriers: 3 }]);
    const day = res.days.find((d) => d.date === '2026-07-10')!;
    expect(day.couriers).toBe(3);
    expect(day.routes.length).toBeLessThanOrEqual(3);
    expect(day.routes.length).toBeGreaterThanOrEqual(1);
  });

  it('populates per-route km + driveMinutes and rolls up makespan + totalKm', () => {
    const pool = [mk('1', 42.71, 23.32), mk('2', 42.72, 23.33)];
    const res = assembleDaySuggestion(pool, new Map(), depot, [{ date: '2026-07-10', couriers: 1 }]);
    const day = res.days[0];
    expect(day.routes[0].km).toBeGreaterThan(0);
    expect(day.routes[0].driveMinutes).toBeGreaterThan(0);
    expect(day.driveMinutesMakespan).toBe(Math.max(...day.routes.map((r) => r.driveMinutes)));
    expect(day.totalKm).toBeCloseTo(Math.round(day.routes.reduce((s, r) => s + r.km, 0) * 10) / 10, 5);
  });

  it('gives a non-empty reason with a compass region when a depot exists', () => {
    const pool = [mk('1', 42.85, 23.32)]; // due north of depot
    const res = assembleDaySuggestion(pool, new Map(), depot, [{ date: '2026-07-10', couriers: 1 }]);
    expect(res.days[0].reason).toContain('север');
  });

  it('falls back to zeros + generic reason when the farm has no depot', () => {
    const pool = [mk('1', 42.71, 23.32)];
    const res = assembleDaySuggestion(pool, new Map(), null, [{ date: '2026-07-10', couriers: 1 }]);
    const day = res.days[0];
    expect(day.totalKm).toBe(0);
    expect(day.driveMinutesMakespan).toBe(0);
    expect(day.reason).toBe('Съседни клиенти заедно — по-малко километри');
  });

  it('merges the day harvest across all its routes and maps un-geocoded to unplaced', () => {
    const pool = [mk('1', 42.71, 23.32), mk('2', 42.72, 23.33), mk('9', null, null)];
    const items = new Map<string, { productName: string | null; quantity: number }[]>([
      ['1', [{ productName: 'Кайсии', quantity: 2 }]],
      ['2', [{ productName: 'Кайсии', quantity: 3 }]],
    ]);
    const res = assembleDaySuggestion(pool, items, depot, [{ date: '2026-07-10', couriers: 1 }]);
    expect(res.days[0].harvest).toEqual([{ productName: 'Кайсии', quantity: 5 }]);
    expect(res.unplaced.map((o) => o.id)).toEqual(['9']);
  });
});
