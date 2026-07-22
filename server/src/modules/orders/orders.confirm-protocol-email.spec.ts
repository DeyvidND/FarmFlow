import { OrdersService } from './orders.service';

/**
 * OrdersService.updateStatus — gates the pending→confirmed transition on the
 * bilateral protocol email (Phase 2, §4.3 human/single confirm path). SAFETY
 * FLOOR: proves render+send happen BEFORE the status-flip write (call order),
 * and that a send failure blocks the flip entirely — the row is never touched
 * and the caller sees a loud error, per the plan's HARD REQUIREMENT (scoped to
 * this one path only — see confirmPending/markOrderPaid, which queue instead).
 * Mirrors the mocking style of orders.delivered-at.spec.ts.
 */
function buildSvc(prevStatus: string | undefined, sendResult: unknown) {
  const rowAfterFlip = { id: 'o1', tenantId: 't1', status: 'confirmed' };
  const callOrder: string[] = [];

  const selectChain: any = {};
  selectChain.from = jest.fn(() => selectChain);
  selectChain.where = jest.fn(() => selectChain);
  selectChain.limit = jest.fn(() => Promise.resolve(prevStatus ? [{ status: prevStatus }] : []));

  const updateChain: any = {};
  updateChain.set = jest.fn(() => updateChain);
  updateChain.where = jest.fn(() => updateChain);
  updateChain.returning = jest.fn(() => {
    callOrder.push('flip');
    return Promise.resolve([rowAfterFlip]);
  });

  const db: any = {};
  db.select = jest.fn(() => selectChain);
  db.update = jest.fn(() => updateChain);

  const cache = { del: jest.fn().mockResolvedValue(undefined), get: jest.fn(), set: jest.fn() };
  const orderEmail = { sendForOrder: jest.fn().mockResolvedValue(undefined) };
  const carrierFulfillment = { autoCreateForOrder: jest.fn().mockResolvedValue(undefined) };
  const protocolEmail = {
    sendProtocolEmail: jest.fn().mockImplementation(async () => {
      callOrder.push('email');
      return sendResult;
    }),
  };

  const svc = new OrdersService(
    db as never,
    {} as never,
    orderEmail as never,
    {} as never,
    cache as never,
    carrierFulfillment as never,
    {} as never,
    {} as never,
    undefined,
    protocolEmail as never,
  );
  return { svc, db, protocolEmail, callOrder };
}

describe('OrdersService.updateStatus — confirm gates on the protocol email (§4.3 human path)', () => {
  it('calls sendProtocolEmail BEFORE writing status=confirmed, and only writes it on success', async () => {
    const { svc, protocolEmail, callOrder } = buildSvc('pending', { ok: true });

    await svc.updateStatus('o1', 't1', { status: 'confirmed' } as never);

    expect(callOrder).toEqual(['email', 'flip']);
    expect(protocolEmail.sendProtocolEmail).toHaveBeenCalledWith('t1', 'o1');
  });

  it('a failed send throws and the row is never flipped to confirmed', async () => {
    const { svc, db } = buildSvc('pending', { ok: false, error: 'SMTP timeout' });

    await expect(svc.updateStatus('o1', 't1', { status: 'confirmed' } as never)).rejects.toThrow(
      /SMTP timeout/,
    );
    expect(db.update).not.toHaveBeenCalled();
  });

  it('re-confirming an already-confirmed order does not re-gate on the email', async () => {
    const { svc, protocolEmail } = buildSvc('confirmed', { ok: true });
    await svc.updateStatus('o1', 't1', { status: 'confirmed' } as never);
    expect(protocolEmail.sendProtocolEmail).not.toHaveBeenCalled();
  });

  it('a non-confirm transition (e.g. delivered) never calls sendProtocolEmail', async () => {
    const { svc, protocolEmail } = buildSvc('confirmed', { ok: true });
    await svc.updateStatus('o1', 't1', { status: 'delivered' } as never);
    expect(protocolEmail.sendProtocolEmail).not.toHaveBeenCalled();
  });
});

/**
 * "Прати пак" (§4.3, Task 9) — re-enqueues the protocol email for an order
 * that may already be `confirmed` (bulk/Stripe paths flip status BEFORE the
 * email outcome is known, so re-running confirm is no longer a valid retry
 * for them). Idempotent by construction: the queue's processor eventually
 * calls sendProtocolEmail, which no-ops on protocol_email_status='sent'.
 */
describe('OrdersService.resendProtocolEmail', () => {
  it('re-enqueues a protocol-email job for an order that belongs to the tenant', async () => {
    const selectChain: any = { from: () => selectChain, where: () => selectChain, limit: () => Promise.resolve([{ id: 'o1' }]) };
    const db: any = { select: jest.fn(() => selectChain) };
    const protocolEmail = { enqueueProtocolEmail: jest.fn().mockResolvedValue(undefined) };
    const svc = new OrdersService(db, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, undefined, protocolEmail as any);

    await svc.resendProtocolEmail('o1', 't1');

    expect(protocolEmail.enqueueProtocolEmail).toHaveBeenCalledWith('t1', 'o1');
  });

  it('throws NotFoundException for a missing/foreign order and never enqueues', async () => {
    const selectChain: any = { from: () => selectChain, where: () => selectChain, limit: () => Promise.resolve([]) };
    const db: any = { select: jest.fn(() => selectChain) };
    const protocolEmail = { enqueueProtocolEmail: jest.fn() };
    const svc = new OrdersService(db, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, undefined, protocolEmail as any);

    await expect(svc.resendProtocolEmail('o1', 't1')).rejects.toThrow(/не е намерена/);
    expect(protocolEmail.enqueueProtocolEmail).not.toHaveBeenCalled();
  });
});

/**
 * findOne's projection is `orderWithSlot` = `{...getTableColumns(orders), ...}`
 * — a full spread, so the 3 Phase-2 tracking columns ride along automatically
 * once Task 1's schema change lands. This is a read-through regression test,
 * not a code change: if findOne ever switches to an explicit column allow-list
 * that drops these fields, this test is what catches it.
 */
describe('OrdersService.findOne — exposes protocol_email_status/_at/_error (Phase 2)', () => {
  function buildFindOneDb(row: unknown) {
    let call = 0;
    const db: any = {
      select: jest.fn(() => {
        call++;
        const result = call === 1 ? [row] : [];
        const c: any = {};
        c.from = jest.fn(() => c);
        c.leftJoin = jest.fn(() => c);
        const wherePromise: any = Promise.resolve(result);
        wherePromise.limit = jest.fn(() => Promise.resolve(result));
        c.where = jest.fn(() => wherePromise);
        return c;
      }),
    };
    return db;
  }

  it('surfaces protocolEmailStatus/At/Error un-stripped through serializeOrder', async () => {
    const protocolEmailAt = new Date('2026-07-22T08:00:00Z');
    const row = {
      id: 'o1',
      tenantId: 't1',
      status: 'confirmed',
      stripeCheckoutSessionId: null,
      stripePaymentIntentId: null,
      paidAt: null,
      protocolEmailStatus: 'sent',
      protocolEmailAt,
      protocolEmailError: null,
    };
    const db = buildFindOneDb(row);
    const svc = new OrdersService(db, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any);

    const result = await svc.findOne('o1', 't1');

    expect(result.protocolEmailStatus).toBe('sent');
    expect(result.protocolEmailAt).toEqual(protocolEmailAt);
    expect(result.protocolEmailError).toBeNull();
  });
});
