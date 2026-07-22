import { DigestService } from './digest.service';

// Single-query mock: orderDaysWithOrders issues exactly one
// select/from/leftJoin/innerJoin/innerJoin/where chain with no further
// .orderBy()/.limit() — it resolves as a bare awaited thenable.
function makeService(rows: Record<string, unknown>[]) {
  const email = { sendMail: jest.fn() };
  const chain: any = {};
  chain.select = jest.fn(() => chain);
  chain.from = jest.fn(() => chain);
  chain.leftJoin = jest.fn(() => chain);
  chain.innerJoin = jest.fn(() => chain);
  chain.where = jest.fn(() => chain);
  chain.then = (resolve: (v: unknown) => void) => resolve(rows);
  return { service: new DigestService(chain as never, email as never) };
}

describe('DigestService.orderDaysWithOrders', () => {
  it('returns [] without querying when no farmer or no valid status is selected', async () => {
    const { service } = makeService([]);
    expect(await service.orderDaysWithOrders('t', { farmerIds: [], statuses: ['confirmed'] })).toEqual([]);
    expect(await service.orderDaysWithOrders('t', { farmerIds: ['f1'], statuses: ['bogus'] })).toEqual([]);
  });

  it('counts DISTINCT orders per day, sorted ascending', async () => {
    const { service } = makeService([
      { day: '2026-07-12', orderId: 'o1' },
      { day: '2026-07-12', orderId: 'o1' }, // second line item on the same order — must not double count
      { day: '2026-07-12', orderId: 'o2' },
      { day: '2026-07-10', orderId: 'o3' },
    ]);
    const res = await service.orderDaysWithOrders('t', {
      farmerIds: ['f1'],
      statuses: ['confirmed'],
      anchor: '2026-07-11',
    });
    expect(res).toEqual([
      { day: '2026-07-10', count: 1 },
      { day: '2026-07-12', count: 2 },
    ]);
  });
});
