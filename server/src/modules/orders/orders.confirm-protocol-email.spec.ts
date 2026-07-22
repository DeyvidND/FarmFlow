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
