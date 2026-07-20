import { OrdersService } from './orders.service';

/**
 * updateOrder must lock the order row (SELECT … FOR UPDATE) inside its transaction
 * BEFORE restoring/reserving stock, and re-assert the collected-money guard against
 * that locked read. This closes the race where a COD collection (codOutcome
 * 'received') or card payment commits between the unlocked outer read and the edit:
 * without the in-tx re-check, the edit proceeds and its stock restore double-counts.
 *
 * Here the OUTER read sees an un-collected order (guard passes), but the LOCKED
 * in-transaction read sees codOutcome='received' — the fixed code must reject.
 */
function makeService(outerRow: Record<string, unknown>, lockedRow: Record<string, unknown>): OrdersService {
  const outerChain: any = {};
  outerChain.from = () => outerChain;
  outerChain.leftJoin = () => outerChain;
  outerChain.where = () => outerChain;
  outerChain.limit = () => Promise.resolve([outerRow]);

  const db: any = { select: () => outerChain };
  db.transaction = async (fn: (tx: unknown) => Promise<unknown>) => {
    const txChain: any = {};
    txChain.from = () => txChain;
    txChain.where = () => txChain;
    txChain.for = () => txChain; // the FOR UPDATE lock the fix introduces
    txChain.limit = () => Promise.resolve([lockedRow]);
    const tx: any = { select: () => txChain };
    return fn(tx);
  };
  const maps: any = { geocode: jest.fn(), geocodeCity: jest.fn() };
  return new OrdersService(db, maps, {} as any, {} as any, {} as any, {} as any, {} as any, { invalidate: jest.fn() } as any);
}

const OUTER = {
  id: 'order-1',
  tenantId: 'tenant-1',
  status: 'confirmed',
  paidAt: null,
  codOutcome: null, // un-collected at the outer read
  deliveryType: 'address',
  totalStotinki: 1000,
  slotId: null,
  slotFrom: null,
  slotTo: null,
  slotDate: null,
};

describe('updateOrder — order-row lock re-checks the collected-money guard', () => {
  // Assert the SPECIFIC collected-money message, not just BadRequestException: the
  // buggy code (no in-tx re-check) would fall through to item processing and throw a
  // DIFFERENT BadRequestException ("Невалиден продукт"), so a bare instanceof check
  // would pass on the bug too. The message pins it to the guard under the lock.
  it('rejects an item edit when COD is marked received between the outer read and the row lock', async () => {
    const svc = makeService(OUTER, { paidAt: null, codOutcome: 'received' });
    await expect(
      svc.updateOrder('order-1', 'tenant-1', {
        items: [{ productId: '11111111-1111-1111-1111-111111111111', quantity: 1 }],
      } as never),
    ).rejects.toThrow(/прибрано плащане/);
  });

  it('rejects an item edit when the order is card-paid at lock time', async () => {
    const svc = makeService(OUTER, { paidAt: new Date(), codOutcome: null });
    await expect(
      svc.updateOrder('order-1', 'tenant-1', {
        items: [{ productId: '11111111-1111-1111-1111-111111111111', quantity: 1 }],
      } as never),
    ).rejects.toThrow(/прибрано плащане/);
  });
});
