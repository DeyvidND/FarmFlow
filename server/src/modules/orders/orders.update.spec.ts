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
