import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { OrdersService } from './orders.service';

/**
 * OrdersService.prepOrders / setFulfillment (Task #14). Mirrors the
 * mocking style of orders.mine.spec.ts (ordersForFarmer): a chainable select
 * stub resolving off the final `.orderBy()`/`.limit()` call.
 */
describe('OrdersService.prepOrders', () => {
  function makeSvc(rows: unknown[]) {
    const chain: any = {};
    chain.select = jest.fn(() => chain);
    chain.from = jest.fn(() => chain);
    chain.innerJoin = jest.fn(() => chain);
    chain.leftJoin = jest.fn(() => chain);
    chain.where = jest.fn(() => chain);
    chain.orderBy = jest.fn(() => Promise.resolve(rows));
    const svc = new OrdersService(
      chain as never, {} as never, {} as never, {} as never,
      {} as never, {} as never, {} as never, {} as never,
    );
    return { svc };
  }

  it('groups line items into one order per orderId, defaulting fulfillmentState to pending when no row exists', async () => {
    const { svc } = makeSvc([
      {
        orderId: 'o1', orderNumber: 5, customerName: 'Мария', customerPhone: '0888111222',
        customerEmail: 'maria@example.com', deliveryType: 'address', day: '2026-07-14',
        slotFrom: '10:00:00', slotTo: '12:00:00', state: null,
        productId: 'p1', productName: 'Домати', quantity: 3,
      },
      {
        orderId: 'o1', orderNumber: 5, customerName: 'Мария', customerPhone: '0888111222',
        customerEmail: 'maria@example.com', deliveryType: 'address', day: '2026-07-14',
        slotFrom: '10:00:00', slotTo: '12:00:00', state: null,
        productId: 'p2', productName: 'Краставици', quantity: 2,
      },
    ]);
    const result = await svc.prepOrders('t', 'farmer-1', '2026-07-14');
    expect(result).toHaveLength(1);
    expect(result[0].fulfillmentState).toBe('pending');
    expect(result[0].items).toHaveLength(2);
    expect(result[0].customerPhone).toBe('0888111222');
  });

  it('surfaces a non-default fulfillmentState from order_fulfillments', async () => {
    const { svc } = makeSvc([
      {
        orderId: 'o2', orderNumber: 6, customerName: 'Иван', customerPhone: null,
        customerEmail: null, deliveryType: 'pickup', day: '2026-07-20',
        slotFrom: null, slotTo: null, state: 'in_production',
        productId: 'p1', productName: 'Мед', quantity: 1,
      },
    ]);
    const result = await svc.prepOrders('t', 'farmer-1', '2026-07-20');
    expect(result[0].fulfillmentState).toBe('in_production');
  });

  it('accepts an arbitrary date and still returns an empty list with no rows', async () => {
    const { svc } = makeSvc([]);
    const result = await svc.prepOrders('t', 'farmer-1', '2026-08-01');
    expect(result).toEqual([]);
  });

  it('defaults to tomorrow when no date is passed (no throw)', async () => {
    const { svc } = makeSvc([]);
    const result = await svc.prepOrders('t', 'farmer-1');
    expect(result).toEqual([]);
  });
});

describe('OrdersService.setFulfillment', () => {
  function makeSvc(ownsRow: unknown[] | undefined) {
    const selectChain: any = {};
    selectChain.select = jest.fn(() => selectChain);
    selectChain.from = jest.fn(() => selectChain);
    selectChain.innerJoin = jest.fn(() => selectChain);
    selectChain.where = jest.fn(() => selectChain);
    selectChain.limit = jest.fn(() => Promise.resolve(ownsRow ?? []));

    const onConflictSpy = jest.fn().mockResolvedValue(undefined);
    const valuesSpy = jest.fn(() => ({ onConflictDoUpdate: onConflictSpy }));
    const insertChain: any = {};
    insertChain.insert = jest.fn(() => insertChain);
    insertChain.values = valuesSpy;

    const db: any = {};
    db.select = jest.fn(() => selectChain);
    db.insert = jest.fn(() => insertChain);

    const svc = new OrdersService(
      db as never, {} as never, {} as never, {} as never,
      {} as never, {} as never, {} as never, {} as never,
    );
    return { svc, valuesSpy, onConflictSpy };
  }

  it('upserts the fulfilment row when the farmer owns at least one item on the order', async () => {
    const { svc, valuesSpy, onConflictSpy } = makeSvc([{ id: 'item-1', status: 'confirmed' }]);
    const result = await svc.setFulfillment('o1', 't1', 'farmer-1', 'fulfilled');
    expect(result).toEqual({ orderId: 'o1', farmerId: 'farmer-1', state: 'fulfilled' });
    expect(valuesSpy).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 't1', orderId: 'o1', farmerId: 'farmer-1', state: 'fulfilled' }),
    );
    expect(onConflictSpy).toHaveBeenCalledWith(
      expect.objectContaining({ set: expect.objectContaining({ state: 'fulfilled' }) }),
    );
  });

  it('throws ForbiddenException when the farmer has NO items on the order (IDOR guard)', async () => {
    const { svc, valuesSpy } = makeSvc([]);
    await expect(svc.setFulfillment('o1', 't1', 'farmer-9', 'fulfilled')).rejects.toThrow(
      ForbiddenException,
    );
    expect(valuesSpy).not.toHaveBeenCalled();
  });

  it('throws BadRequestException self-marking fulfilment on a non-active order (e.g. cancelled)', async () => {
    const { svc, valuesSpy } = makeSvc([{ id: 'item-1', status: 'cancelled' }]);
    await expect(svc.setFulfillment('o1', 't1', 'farmer-1', 'fulfilled')).rejects.toThrow(
      BadRequestException,
    );
    expect(valuesSpy).not.toHaveBeenCalled();
  });
});
