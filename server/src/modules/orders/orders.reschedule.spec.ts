import { BadRequestException } from '@nestjs/common';
import { OrdersService } from './orders.service';

const TENANT = 'tenant-1';
const UUID = (n: number) => `${n}`.padStart(8, '0') + '-0000-0000-0000-000000000000';

/**
 * Build a service whose:
 *  - first `db.select` (the load) resolves to `loadRows`
 *  - `db.transaction` runs the callback against a tx that:
 *      • answers `select(...).for('update')` for the target-slot lookup with `existingSlot`
 *      • records inserted slot rows into `inserted`
 *      • records `update(orders).set(v).where()` values into `setCalls`
 */
function makeSvc(opts: {
  loadRows: Record<string, unknown>[];
  existingSlot?: { id: string };
}) {
  const setCalls: Record<string, unknown>[] = [];
  const inserted: Record<string, unknown>[] = [];
  const sendMoved = jest.fn().mockResolvedValue(undefined);

  const loadChain: any = {};
  loadChain.from = () => loadChain;
  loadChain.leftJoin = () => loadChain;
  loadChain.innerJoin = () => loadChain;
  loadChain.where = () => loadChain;
  loadChain.orderBy = () => Promise.resolve(opts.loadRows);
  loadChain.limit = () => Promise.resolve(opts.loadRows);

  const db: any = {
    select: () => loadChain,
    transaction: jest.fn(async (fn: (tx: any) => Promise<unknown>) => {
      const tx: any = {
        select: () => {
          const c: any = {};
          c.from = () => c;
          c.leftJoin = () => c;
          c.where = () => c;
          c.for = () => c;
          c.limit = () => Promise.resolve(opts.existingSlot ? [opts.existingSlot] : []);
          return c;
        },
        insert: () => ({
          values: (v: Record<string, unknown>) => ({
            returning: () => {
              inserted.push(v);
              return Promise.resolve([{ id: 'new-slot' }]);
            },
          }),
        }),
        update: () => ({
          set: (v: Record<string, unknown>) => ({
            where: () => {
              setCalls.push(v);
              return Promise.resolve();
            },
          }),
        }),
      };
      return fn(tx);
    }),
  };

  // Constructor order: db, maps, orderEmail, econt, cache, carrierFulfillment, codRisk, catalogCache
  const svc = new OrdersService(
    db,
    {} as any,
    { sendMoved } as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
  );
  jest.spyOn(svc as any, 'bustPayments').mockResolvedValue(undefined);
  return { svc, setCalls, inserted, sendMoved };
}

describe('OrdersService.rescheduleOrders', () => {
  const addr = (over: Record<string, unknown> = {}) => ({
    id: UUID(1), status: 'pending', deliveryType: 'address', slotId: 'old-slot', fromDate: '2026-07-09', ...over,
  });

  it('creates a HIDDEN slot for an unopened date and reassigns', async () => {
    const { svc, setCalls, inserted, sendMoved } = makeSvc({ loadRows: [addr()] });
    const res = await svc.rescheduleOrders(TENANT, { orderIds: [UUID(1)], toDate: '2026-12-31' });
    expect(inserted).toHaveLength(1);
    expect(inserted[0].isActive).toBe(false);
    expect(inserted[0].date).toBe('2026-12-31');
    expect(setCalls).toEqual([{ slotId: 'new-slot' }]);
    expect(res).toEqual({ moved: 1, toDate: '2026-12-31' });
    expect(sendMoved).toHaveBeenCalledWith(UUID(1), '2026-07-09', '2026-12-31');
  });

  it('reuses an existing slot for the target date (no insert)', async () => {
    const { svc, inserted, setCalls } = makeSvc({ loadRows: [addr()], existingSlot: { id: 'exists' } });
    await svc.rescheduleOrders(TENANT, { orderIds: [UUID(1)], toDate: '2026-12-31' });
    expect(inserted).toHaveLength(0);
    expect(setCalls).toEqual([{ slotId: 'exists' }]);
  });

  it('skips non-address / delivered / cancelled orders', async () => {
    const rows = [
      addr({ id: UUID(1), deliveryType: 'econt' }),
      addr({ id: UUID(2), status: 'delivered' }),
      addr({ id: UUID(3), status: 'cancelled' }),
    ];
    const { svc } = makeSvc({ loadRows: rows });
    await expect(
      svc.rescheduleOrders(TENANT, { orderIds: [UUID(1), UUID(2), UUID(3)], toDate: '2026-12-31' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a past target date', async () => {
    const { svc } = makeSvc({ loadRows: [addr()] });
    await expect(
      svc.rescheduleOrders(TENANT, { orderIds: [UUID(1)], toDate: '2000-01-01' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('no-ops an order already on the target slot (no email, moved=0)', async () => {
    const { svc, setCalls, sendMoved } = makeSvc({
      loadRows: [addr({ slotId: 'exists' })],
      existingSlot: { id: 'exists' },
    });
    const res = await svc.rescheduleOrders(TENANT, { orderIds: [UUID(1)], toDate: '2026-12-31' });
    expect(setCalls).toHaveLength(0);
    expect(sendMoved).not.toHaveBeenCalled();
    expect(res.moved).toBe(0);
  });
});
