import { HandoverService } from './handover.service';

/**
 * The order-id filter inside `listForCheck`. A protocol links to orders TWO ways —
 * `orderId` for an operator→customer receipt, `orderIds[]` for a farmer→operator
 * pickup covering several orders — and missing either one would leak a
 * counterparty's name and address to a courier who isn't carrying those goods.
 */

const TENANT = 't1';

const row = (over: Record<string, unknown>) => ({
  id: 'p1',
  protocolNumber: 1,
  kind: 'operator_to_customer',
  status: 'signed',
  signedAt: null,
  fromSnapshot: { name: 'Ферма' },
  toSnapshot: { name: 'Клиент' },
  items: [],
  orderId: null,
  orderIds: null,
  fromSignaturePng: null,
  toSignaturePng: null,
  ...over,
});

function svc(rows: unknown[]) {
  // Only `list` is reached (stubbed below), so the injected db is never touched.
  const s = new HandoverService({} as any);
  jest.spyOn(s as any, 'list').mockResolvedValue(rows);
  return s;
}

describe('HandoverService.listForCheck — driver order filter', () => {
  const mine = new Set(['order-A']);

  it('keeps a receipt whose single orderId is on the leg', async () => {
    const s = svc([row({ id: 'keep', orderId: 'order-A' })]);
    const out = await s.listForCheck(TENANT, {}, mine);
    expect(out.map((r) => r.id)).toEqual(['keep']);
  });

  it('drops a receipt for another courier’s order', async () => {
    const s = svc([row({ id: 'drop', orderId: 'order-C' })]);
    expect(await s.listForCheck(TENANT, {}, mine)).toEqual([]);
  });

  it('keeps a farmer pickup when ANY order in its orderIds array is on the leg', async () => {
    const s = svc([
      row({ id: 'keep', kind: 'farmer_to_operator', orderIds: ['order-Z', 'order-A'] }),
    ]);
    expect((await s.listForCheck(TENANT, {}, mine)).map((r) => r.id)).toEqual(['keep']);
  });

  it('drops a farmer pickup whose orderIds are all another leg’s', async () => {
    const s = svc([row({ id: 'drop', kind: 'farmer_to_operator', orderIds: ['order-Y', 'order-Z'] })]);
    expect(await s.listForCheck(TENANT, {}, mine)).toEqual([]);
  });

  it('drops a protocol linked to no order at all when scoped', async () => {
    const s = svc([row({ id: 'orphan', orderId: null, orderIds: null })]);
    expect(await s.listForCheck(TENANT, {}, mine)).toEqual([]);
  });

  it('returns everything when NO scope is given — the owner path is unchanged', async () => {
    const s = svc([
      row({ id: 'a', orderId: 'order-A' }),
      row({ id: 'c', orderId: 'order-C' }),
      row({ id: 'orphan' }),
    ]);
    expect((await s.listForCheck(TENANT, {})).map((r) => r.id)).toEqual(['a', 'c', 'orphan']);
  });

  it('still drops UNSIGNED protocols even when they are on the leg', async () => {
    const s = svc([row({ id: 'draft', status: 'draft', orderId: 'order-A' })]);
    expect(await s.listForCheck(TENANT, {}, mine)).toEqual([]);
  });
});
