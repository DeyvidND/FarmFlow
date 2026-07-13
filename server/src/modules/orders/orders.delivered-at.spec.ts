import { OrdersService } from './orders.service';

/**
 * OrdersService.updateStatus — delivered_at set/clear (Task #9/#10). Turnover-
 * by-delivered-day needs a real "when it happened" timestamp distinct from
 * created_at (order-placed day); this asserts it is written exactly once on
 * the first transition into 'delivered' and cleared on any transition back out.
 * Mirrors the mocking style of orders.cod-outcome-revert.spec.ts.
 */
function makeSvc(prevStatus: string | undefined) {
  const updatedRow = { id: 'o1', tenantId: 't1', status: 'delivered', paymentMethod: 'cod', codOutcome: null };
  const selectChain: any = {};
  selectChain.select = jest.fn(() => selectChain);
  selectChain.from = jest.fn(() => selectChain);
  selectChain.where = jest.fn(() => selectChain);
  selectChain.limit = jest.fn(() => Promise.resolve(prevStatus ? [{ status: prevStatus }] : []));

  const setSpy = jest.fn((..._args: unknown[]) => updateChain);
  const updateChain: any = {};
  updateChain.update = jest.fn(() => updateChain);
  updateChain.set = setSpy;
  updateChain.where = jest.fn(() => updateChain);
  updateChain.returning = jest.fn(() => Promise.resolve([updatedRow]));

  const db: any = {};
  db.select = jest.fn(() => selectChain);
  db.update = jest.fn(() => updateChain);

  const cache = { del: jest.fn().mockResolvedValue(undefined), get: jest.fn(), set: jest.fn() };
  const orderEmail = { sendForOrder: jest.fn().mockResolvedValue(undefined) };
  const carrierFulfillment = { autoCreateForOrder: jest.fn().mockResolvedValue(undefined) };

  const svc = new OrdersService(
    db as never,
    {} as never,
    orderEmail as never,
    {} as never,
    cache as never,
    carrierFulfillment as never,
    {} as never,
    {} as never,
    { voidForOrder: jest.fn(), accrueForOrder: jest.fn() } as never,
  );
  return { svc, setSpy };
}

describe('OrdersService.updateStatus — delivered_at (Task #9/#10)', () => {
  it('sets deliveredAt on the first pending→delivered-adjacent transition into delivered', async () => {
    const { svc, setSpy } = makeSvc('out_for_delivery');
    await svc.updateStatus('o1', 't1', { status: 'delivered' } as never);
    const payload = setSpy.mock.calls[0][0] as any;
    expect(payload.status).toBe('delivered');
    expect(payload.deliveredAt).toBeInstanceOf(Date);
  });

  it('does NOT re-bump deliveredAt on a delivered→delivered re-mark', async () => {
    const { svc, setSpy } = makeSvc('delivered');
    await svc.updateStatus('o1', 't1', { status: 'delivered' } as never);
    const payload = setSpy.mock.calls[0][0] as any;
    expect(payload.status).toBe('delivered');
    expect('deliveredAt' in payload).toBe(false);
  });

  it('clears deliveredAt when status moves back out of delivered', async () => {
    const { svc, setSpy } = makeSvc('delivered');
    await svc.updateStatus('o1', 't1', { status: 'out_for_delivery' } as never);
    const payload = setSpy.mock.calls[0][0] as any;
    expect(payload.status).toBe('out_for_delivery');
    expect(payload.deliveredAt).toBeNull();
  });

  it('leaves deliveredAt untouched for a transition never involving delivered', async () => {
    const { svc, setSpy } = makeSvc('confirmed');
    await svc.updateStatus('o1', 't1', { status: 'preparing' } as never);
    const payload = setSpy.mock.calls[0][0] as any;
    expect(payload.status).toBe('preparing');
    expect('deliveredAt' in payload).toBe(false);
  });
});
