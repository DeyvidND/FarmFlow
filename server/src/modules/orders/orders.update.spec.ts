/**
 * Guard tests for OrdersService.updateOrder — these all short-circuit BEFORE the
 * transaction, so the DB mock only needs to answer the initial order load.
 */
import { BadRequestException } from '@nestjs/common';
import { OrdersService } from './orders.service';

/** Minimal db mock whose first (and only) select resolves to `[orderRow]`. */
function serviceWithOrder(orderRow: Record<string, unknown>): OrdersService {
  const chain: any = {};
  chain.from = () => chain;
  chain.leftJoin = () => chain;
  chain.where = () => chain;
  chain.limit = () => Promise.resolve([orderRow]);
  const db: any = { select: () => chain };
  // Only `db` and `maps` are touched on the guard paths.
  const maps: any = { geocode: jest.fn(), geocodeCity: jest.fn() };
  return new OrdersService(db, maps, {} as any, {} as any, {} as any, {} as any, {} as any);
}

const BASE = {
  id: 'order-1',
  tenantId: 'tenant-1',
  status: 'confirmed',
  paidAt: null,
  deliveryType: 'address',
  totalStotinki: 1000,
  slotId: null,
  slotFrom: null,
  slotTo: null,
  slotDate: null,
};

describe('updateOrder guards', () => {
  it('rejects editing a delivered order', async () => {
    const svc = serviceWithOrder({ ...BASE, status: 'delivered' });
    await expect(svc.updateOrder('order-1', 'tenant-1', { customerName: 'Х' })).rejects.toBeInstanceOf(BadRequestException);
  });
  it('rejects editing a cancelled order', async () => {
    const svc = serviceWithOrder({ ...BASE, status: 'cancelled' });
    await expect(svc.updateOrder('order-1', 'tenant-1', { customerName: 'Х' })).rejects.toBeInstanceOf(BadRequestException);
  });
  it('rejects editing a preparing order (allowlist, not just delivered/cancelled)', async () => {
    const svc = serviceWithOrder({ ...BASE, status: 'preparing' });
    await expect(svc.updateOrder('order-1', 'tenant-1', { customerName: 'Х' })).rejects.toBeInstanceOf(BadRequestException);
  });
  it('rejects editing an out_for_delivery order', async () => {
    const svc = serviceWithOrder({ ...BASE, status: 'out_for_delivery' });
    await expect(svc.updateOrder('order-1', 'tenant-1', { customerName: 'Х' })).rejects.toBeInstanceOf(BadRequestException);
  });
  it('rejects item edits on a card-paid order', async () => {
    const svc = serviceWithOrder({ ...BASE, paidAt: new Date() });
    await expect(
      svc.updateOrder('order-1', 'tenant-1', { items: [{ productId: '11111111-1111-1111-1111-111111111111', quantity: 1 }] }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

/**
 * Regression coverage for a changed (non-empty) address whose geocode lookup
 * misses (no match, or Maps disabled). The OLD lat/lng/city must not survive
 * under the NEW address text — they must be written as explicit `null`, never
 * left `undefined` (which the `!== undefined` write-guard would skip).
 */
describe('updateOrder geocode-miss clears stale coordinates/city', () => {
  /** Builds a service whose `findOne` is stubbed out (already covered elsewhere)
   *  so the test can focus on the `set` object written by the update inside the
   *  transaction. `setCapture` collects every `tx.update(orders).set(...)` call. */
  function serviceForGeocodeMiss(
    orderRow: Record<string, unknown>,
    setCapture: Record<string, unknown>[],
    maps: { geocode: jest.Mock; geocodeCity: jest.Mock },
  ): OrdersService {
    const orderChain: any = {};
    orderChain.from = () => orderChain;
    orderChain.leftJoin = () => orderChain;
    orderChain.where = () => orderChain;
    orderChain.limit = () => Promise.resolve([orderRow]);

    const tenantChain: any = {};
    tenantChain.from = () => tenantChain;
    tenantChain.where = () => tenantChain;
    tenantChain.limit = () => Promise.resolve([{ farmLat: null, farmLng: null }]);

    let selectCall = 0;
    const db: any = {
      select: jest.fn(() => (selectCall++ === 0 ? orderChain : tenantChain)),
      transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
        const tx: any = {
          update: jest.fn(() => {
            const c: any = {};
            c.set = jest.fn((v: Record<string, unknown>) => {
              setCapture.push(v);
              return c;
            });
            c.where = jest.fn(() => Promise.resolve([]));
            return c;
          }),
        };
        return fn(tx);
      }),
    };
    const cache: any = { del: jest.fn().mockResolvedValue(undefined) };
    const svc = new OrdersService(db, maps as any, {} as any, {} as any, cache, {} as any, {} as any);
    jest.spyOn(svc, 'findOne').mockResolvedValue({} as any);
    return svc;
  }

  it('nulls out stale lat/lng when the new address fails to geocode (deliveryType: address)', async () => {
    const setCapture: Record<string, unknown>[] = [];
    const maps = { geocode: jest.fn().mockResolvedValue(null), geocodeCity: jest.fn() };
    const svc = serviceForGeocodeMiss(
      { ...BASE, deliveryType: 'address', deliveryAddress: 'ул. Стара 1', deliveryLat: '42.0', deliveryLng: '23.0' },
      setCapture,
      maps,
    );
    await svc.updateOrder('order-1', 'tenant-1', { deliveryAddress: 'несъществуващ адрес 999' });
    expect(maps.geocode).toHaveBeenCalled();
    expect(setCapture).toHaveLength(1);
    expect(setCapture[0].deliveryLat).toBeNull();
    expect(setCapture[0].deliveryLng).toBeNull();
  });

  it('nulls out stale city when the new address fails to resolve a city (deliveryType: econt_address)', async () => {
    const setCapture: Record<string, unknown>[] = [];
    const maps = { geocode: jest.fn(), geocodeCity: jest.fn().mockResolvedValue(null) };
    const svc = serviceForGeocodeMiss(
      { ...BASE, deliveryType: 'econt_address', deliveryAddress: 'ул. Стара 1', deliveryCity: 'София' },
      setCapture,
      maps,
    );
    await svc.updateOrder('order-1', 'tenant-1', { deliveryAddress: 'несъществуващ адрес 999' });
    expect(maps.geocodeCity).toHaveBeenCalled();
    expect(setCapture).toHaveLength(1);
    expect(setCapture[0].deliveryCity).toBeNull();
  });
});
