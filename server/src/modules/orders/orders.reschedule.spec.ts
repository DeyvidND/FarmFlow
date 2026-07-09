import { BadRequestException } from '@nestjs/common';
import { OrdersService } from './orders.service';

const TENANT = 'tenant-1';
const UUID = (n: number) => `${n}`.padStart(8, '0') + '-0000-0000-0000-000000000000';

/**
 * Build a service whose `db.transaction` runs the callback against a tx that:
 *  - answers `tx.execute(...)` (the advisory lock) by resolving immediately
 *  - answers the movable-order read (`select().from().leftJoin().where().limit()`)
 *    with `loadRows`
 *  - answers `select(...).for('update')` for the target-slot lookup with `existingSlot`
 *  - records inserted slot rows into `inserted`
 *  - records `update(orders).set(v).where()` values into `setCalls`, then resolves
 *    `.returning()` with `updateReturns` (defaults to a single claimed row) so the
 *    atomic UPDATE...RETURNING race-gate has something to match against
 *
 * The movable-order read and the target-slot lookup share the same tx.select()
 * factory shape, so we distinguish them by whether `.for('update')` was called:
 * only the target-slot lookup calls `.for(...)`.
 */
function makeSvc(opts: {
  loadRows: Record<string, unknown>[];
  existingSlot?: { id: string };
  /** What each per-row UPDATE...RETURNING resolves to, in call order. Defaults to
   *  always returning a claimed row (i.e. no race). Pass `[]` for a given call to
   *  simulate a concurrent status change that un-movable-ized the row first. */
  updateReturns?: Record<string, unknown>[][];
  /** tenant.settings for the post-move getSlotRule() lookup (drives whether the
   *  target date is a genuinely-offered rule day → left public → not deactivated). */
  settings?: Record<string, unknown> | null;
}) {
  const setCalls: Record<string, unknown>[] = [];
  const inserted: Record<string, unknown>[] = [];
  // Top-level db.update(deliverySlots).set({isActive:false}) calls — the post-move
  // "hide a non-rule target day" deactivation (outside the transaction).
  const deactivations: Record<string, unknown>[] = [];
  const sendMoved = jest.fn().mockResolvedValue(undefined);

  const db: any = {
    transaction: jest.fn(async (fn: (tx: any) => Promise<unknown>) => {
      const tx: any = {
        execute: () => Promise.resolve(),
        select: () => {
          let usedFor = false;
          const c: any = {};
          c.from = () => c;
          c.leftJoin = () => c;
          c.where = () => c;
          c.for = () => {
            usedFor = true;
            return c;
          };
          c.limit = () =>
            usedFor
              ? Promise.resolve(opts.existingSlot ? [opts.existingSlot] : [])
              : Promise.resolve(opts.loadRows);
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
            where: () => ({
              returning: () => {
                const idx = setCalls.length;
                setCalls.push(v);
                const claimed = opts.updateReturns?.[idx] ?? [{ id: 'claimed' }];
                return Promise.resolve(claimed);
              },
            }),
          }),
        }),
      };
      return fn(tx);
    }),
    // Post-move getSlotRule() reads tenant.settings (top-level, outside the tx).
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => [{ settings: opts.settings ?? null }] }) }),
    }),
    // Post-move deactivation of a non-rule target day (top-level, outside the tx).
    update: () => ({
      set: (v: Record<string, unknown>) => ({
        where: async () => {
          deactivations.push(v);
        },
      }),
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
  return { svc, setCalls, inserted, sendMoved, deactivations };
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

  // Thursday-only recurring rule — Friday is NOT an offered day.
  const thuRule = {
    slotRule: {
      active: true,
      repeat: 'weekdays',
      days: [{ dow: 4, capacity: 48 }],
      intervalDays: 1,
      intervalCapacity: 1,
      anchorDate: '2026-07-01',
      horizonDays: 30,
      skipDates: [],
    },
  };

  it('hides a REUSED active slot on a non-rule day so the moved-orders day leaves the storefront', async () => {
    // The exact live bug: rule is Thursday-only but orders were moved onto Friday and
    // the reused (active) Friday slot kept showing on the storefront.
    const { svc, deactivations } = makeSvc({
      loadRows: [addr()],
      existingSlot: { id: 'friday' },
      settings: thuRule,
    });
    await svc.rescheduleOrders(TENANT, { orderIds: [UUID(1)], toDate: '2026-07-10' }); // Friday
    expect(deactivations).toEqual([{ isActive: false }]);
  });

  it('leaves a rule day (Thursday) public when orders are consolidated onto it', async () => {
    const { svc, deactivations } = makeSvc({
      loadRows: [addr()],
      existingSlot: { id: 'thursday' },
      settings: thuRule,
    });
    await svc.rescheduleOrders(TENANT, { orderIds: [UUID(1)], toDate: '2026-07-16' }); // Thursday
    expect(deactivations).toEqual([]); // rule offers this day → stays active/public
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

  it('silently skips a row raced by a concurrent status change (UPDATE...RETURNING empty)', async () => {
    // Snapshot read still sees both rows as movable, but the per-row UPDATE...RETURNING
    // for order 1 comes back empty — simulating a concurrent cancel between the read
    // and the write. Order 2's UPDATE still claims normally.
    const { svc, setCalls, sendMoved } = makeSvc({
      loadRows: [addr({ id: UUID(1) }), addr({ id: UUID(2), fromDate: '2026-07-10' })],
      updateReturns: [[], [{ id: UUID(2) }]],
    });
    const res = await svc.rescheduleOrders(TENANT, { orderIds: [UUID(1), UUID(2)], toDate: '2026-12-31' });
    // Both UPDATEs were attempted (the WHERE-clause race check doesn't short-circuit
    // the loop), but only order 2's claim counts as moved.
    expect(setCalls).toEqual([{ slotId: 'new-slot' }, { slotId: 'new-slot' }]);
    expect(res).toEqual({ moved: 1, toDate: '2026-12-31' });
    expect(sendMoved).toHaveBeenCalledTimes(1);
    expect(sendMoved).toHaveBeenCalledWith(UUID(2), '2026-07-10', '2026-12-31');
  });
});
