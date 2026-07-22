import { DigestService } from './digest.service';

// Single-query mock: orderDaysWithOrders issues exactly one
// select/from/leftJoin/innerJoin/innerJoin/where/groupBy chain with no further
// .orderBy()/.limit() — it resolves as a bare awaited thenable. Dedup + count
// now happen in SQL (count(distinct orderId) grouped by the coalesced day), so
// the mock seeds pre-aggregated {day, count} rows and this spec proves the JS
// sort + passthrough, not the dedupe itself.
function makeService(rows: Record<string, unknown>[]) {
  const email = { sendMail: jest.fn() };
  const chain: any = {};
  chain.select = jest.fn(() => chain);
  chain.from = jest.fn(() => chain);
  chain.leftJoin = jest.fn(() => chain);
  chain.innerJoin = jest.fn(() => chain);
  chain.where = jest.fn(() => chain);
  chain.groupBy = jest.fn(() => chain);
  chain.then = (resolve: (v: unknown) => void) => resolve(rows);
  return { service: new DigestService(chain as never, email as never) };
}

describe('DigestService.orderDaysWithOrders', () => {
  it('returns [] without querying when no farmer or no valid status is selected', async () => {
    const { service } = makeService([]);
    expect(await service.orderDaysWithOrders('t', { farmerIds: [], statuses: ['confirmed'] })).toEqual([]);
    expect(await service.orderDaysWithOrders('t', { farmerIds: ['f1'], statuses: ['bogus'] })).toEqual([]);
  });

  it('sorts pre-aggregated day/count rows ascending (dedupe + count happen in SQL)', async () => {
    const { service } = makeService([
      { day: '2026-07-12', count: 2 }, // e.g. o1 (2 line items) + o2, deduped by SQL
      { day: '2026-07-10', count: 1 },
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
