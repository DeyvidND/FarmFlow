import { OrderProtocolEmailService } from './order-protocol-email.service';

function buildDeps(orderRow: any, claimResult: any[] = [{ id: orderRow?.id }]) {
  const updateCalls: any[] = [];
  // The claim update is `update().set().where().returning()`; the terminal
  // (failed/sent) writes are `update().set().where()` with no `.returning()`.
  // Both must be supported by the same mock chain since the service reuses
  // `this.db.update(orders)` for all three.
  const updateChain: any = {};
  updateChain.set = jest.fn((vals: any) => {
    updateCalls.push(vals);
    return updateChain;
  });
  updateChain.where = jest.fn(() => updateChain);
  updateChain.returning = jest.fn(() => Promise.resolve(claimResult));
  // `where()` alone (no `.returning()` chained) must also resolve like a
  // real drizzle thenable for the terminal writes — give it `.then`.
  updateChain.then = (resolve: any) => resolve(undefined);

  const selectChain: any = {};
  selectChain.from = jest.fn(() => selectChain);
  selectChain.where = jest.fn(() => selectChain);
  selectChain.limit = jest.fn(() => Promise.resolve([orderRow]));
  const db: any = {
    select: jest.fn(() => selectChain),
    update: jest.fn(() => updateChain),
  };
  const handover = {
    ensureDraftTarget: jest.fn().mockResolvedValue({ id: 'protocol-1' }),
    renderPdfForEmail: jest.fn().mockResolvedValue(Buffer.from('%PDF-1.4 real bytes')),
  };
  const email = { sendMailNow: jest.fn().mockResolvedValue(undefined) };
  const queue = { add: jest.fn().mockResolvedValue(undefined) };
  return { db, handover, email, queue, updateCalls, updateChain };
}

describe('OrderProtocolEmailService.sendProtocolEmail', () => {
  // DEVIATION from the plan doc's literal Step 1 tests: the plan's own two
  // tests here asserted that `sendProtocolEmail` calls
  // `handover.renderPdfForEmail` directly — but the plan's OWN Step 4
  // implementation sample (and its architecture section, "materialized to
  // bytes inside EmailService.deliver() via an injected resolver token")
  // deliberately does NOT render bytes at this layer: it only calls
  // `ensureDraftTarget` to obtain a real protocolId, then hands a LAZY
  // `{kind, protocolId, tenantId}` descriptor to `email.sendMailNow` — actual
  // PDF rendering happens one layer down, inside `EmailService.deliver()`'s
  // attachment-resolver step (already proven for real, with actual bytes
  // reaching `writePreview`, by Task 4's `email.service.spec.ts`). Asserting
  // `renderPdfForEmail` was called HERE would only pass if this service
  // double-rendered the PDF (once eagerly, discarded; once lazily inside
  // EmailService) — defeating the whole point of lazy materialization (fresh
  // bytes per retry, small BullMQ job payloads). Rewritten below to assert
  // the real contract at this layer instead: a REAL (non-placeholder)
  // protocolId — obtained via `ensureDraftTarget`, not hardcoded — flows
  // through into the descriptor handed to `sendMailNow`.
  it('claims the row, then gets the draft protocol + sends BEFORE writing protocol_email_status=sent (order of operations)', async () => {
    const order = { id: 'o1', tenantId: 't1', customerEmail: 'buyer@x.bg', customerName: 'Иван', orderNumber: 42, protocolEmailStatus: null };
    const { db, handover, email, queue } = buildDeps(order, [{ id: 'o1' }]);
    const callOrder: string[] = [];
    db.update.mockImplementation(() => {
      const chain: any = {};
      chain.set = jest.fn((vals: any) => {
        callOrder.push(vals.protocolEmailStatus === 'sending' ? 'claim' : 'write-status');
        return chain;
      });
      chain.where = jest.fn(() => chain);
      chain.returning = jest.fn(() => Promise.resolve([{ id: 'o1' }]));
      chain.then = (resolve: any) => resolve(undefined);
      return chain;
    });
    handover.ensureDraftTarget.mockImplementation(async () => { callOrder.push('draft'); return { id: 'protocol-1' }; });
    email.sendMailNow.mockImplementation(async () => { callOrder.push('send'); });

    const svc = new OrderProtocolEmailService(db, handover as any, email as any, queue as any);
    const result = await svc.sendProtocolEmail('t1', 'o1');

    expect(result).toEqual({ ok: true });
    expect(callOrder).toEqual(['claim', 'draft', 'send', 'write-status']);
    expect(email.sendMailNow).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'buyer@x.bg',
        attachments: [{ kind: 'handover-protocol', protocolId: 'protocol-1', tenantId: 't1' }],
      }),
    );
  });

  it('passes a REAL (non-placeholder) protocolId descriptor to the mailer, sourced from ensureDraftTarget — not eagerly-rendered bytes', async () => {
    const order = { id: 'o1', tenantId: 't1', customerEmail: 'buyer@x.bg', customerName: 'Иван', orderNumber: 42, protocolEmailStatus: null };
    const { db, handover, email, queue } = buildDeps(order, [{ id: 'o1' }]);
    handover.ensureDraftTarget.mockResolvedValue({ id: 'protocol-XYZ-real' });

    const svc = new OrderProtocolEmailService(db, handover as any, email as any, queue as any);
    await svc.sendProtocolEmail('t1', 'o1');

    expect(handover.ensureDraftTarget).toHaveBeenCalledWith(
      't1',
      expect.objectContaining({ kind: 'operator_to_customer', orderId: 'o1' }),
    );
    const call = email.sendMailNow.mock.calls[0][0];
    // The id in the descriptor is THE ONE ensureDraftTarget actually
    // returned — not a literal baked into the implementation — proving the
    // wiring is real, not vacuous.
    expect(call.attachments).toEqual([{ kind: 'handover-protocol', protocolId: 'protocol-XYZ-real', tenantId: 't1' }]);
    // The eager-render path is NOT exercised at this layer (see note above) —
    // real-byte materialization is proven end-to-end by email.service.spec.ts.
    expect(handover.renderPdfForEmail).not.toHaveBeenCalled();
  });

  it('a mailer failure leaves protocol_email_status=failed and does NOT write sent (claim precedes the failure write)', async () => {
    const order = { id: 'o1', tenantId: 't1', customerEmail: 'buyer@x.bg', customerName: 'Иван', orderNumber: 42, protocolEmailStatus: null };
    const { db, handover, email, queue, updateCalls } = buildDeps(order, [{ id: 'o1' }]);
    email.sendMailNow.mockRejectedValue(new Error('SMTP timeout'));

    const svc = new OrderProtocolEmailService(db, handover as any, email as any, queue as any);
    const result = await svc.sendProtocolEmail('t1', 'o1');

    expect(result).toEqual({ ok: false, error: 'SMTP timeout' });
    // A 'sending' claim write precedes the 'failed' write — assert the
    // failure write is present via toContainEqual rather than requiring it
    // be the only update() call.
    expect(updateCalls).toContainEqual(
      expect.objectContaining({ protocolEmailStatus: 'failed', protocolEmailError: 'SMTP timeout' }),
    );
    expect(updateCalls.some((c) => c.protocolEmailStatus === 'sent')).toBe(false);
  });

  it('skips render+send and reports skipped when the order has no email on file (does not claim)', async () => {
    const order = { id: 'o1', tenantId: 't1', customerEmail: null, customerName: 'Иван', orderNumber: 42, protocolEmailStatus: null };
    const { db, handover, email, queue } = buildDeps(order);
    const svc = new OrderProtocolEmailService(db, handover as any, email as any, queue as any);

    const result = await svc.sendProtocolEmail('t1', 'o1');

    expect(result).toEqual({ ok: true, skipped: 'no-email' });
    expect(db.update).not.toHaveBeenCalled();
    expect(handover.ensureDraftTarget).not.toHaveBeenCalled();
    expect(email.sendMailNow).not.toHaveBeenCalled();
  });

  it('idempotent: a second call after protocol_email_status=sent does not resend (fast-path skip, no claim)', async () => {
    const order = { id: 'o1', tenantId: 't1', customerEmail: 'buyer@x.bg', customerName: 'Иван', orderNumber: 42, protocolEmailStatus: 'sent' };
    const { db, handover, email, queue } = buildDeps(order);
    const svc = new OrderProtocolEmailService(db, handover as any, email as any, queue as any);

    const result = await svc.sendProtocolEmail('t1', 'o1');

    expect(result).toEqual({ ok: true, skipped: 'already-sent' });
    expect(db.update).not.toHaveBeenCalled();
    expect(email.sendMailNow).not.toHaveBeenCalled();
    expect(handover.ensureDraftTarget).not.toHaveBeenCalled();
  });

  // NEW dup-prevention test. Non-vacuity check performed manually: reverting
  // the claim's `.where()` guard to unconditional (or removing the `!claimed`
  // early-return) makes this test FAIL, because `sendMailNow`/
  // `ensureDraftTarget` would then be called even though `.returning()` here
  // resolves to `[]` — i.e. this test only passes because the service
  // actually branches on the claim result. Confirmed by re-reading the
  // implementation: `if (!claimed) return { ok: true, skipped: 'already-sent' };`
  // sits directly after the `.returning()` call and precedes both
  // `ensureDraftTarget` and `sendMailNow`, so an empty claim result short-
  // circuits before either side effect — there is no code path that would
  // make this pass "by accident".
  it('dup-prevention: an empty claim (another worker/webhook already owns it) skips send entirely', async () => {
    const order = { id: 'o1', tenantId: 't1', customerEmail: 'buyer@x.bg', customerName: 'Иван', orderNumber: 42, protocolEmailStatus: null };
    const { db, handover, email, queue } = buildDeps(order, []); // claim returns no rows

    const svc = new OrderProtocolEmailService(db, handover as any, email as any, queue as any);
    const result = await svc.sendProtocolEmail('t1', 'o1');

    expect(result).toEqual({ ok: true, skipped: 'already-sent' });
    expect(handover.ensureDraftTarget).not.toHaveBeenCalled();
    expect(email.sendMailNow).not.toHaveBeenCalled();
  });

  // NEW first-send test: NULL protocolEmailStatus is the normal first-ever
  // send — must be claimable (the `IS NULL OR = 'failed'` guard, not `<>
  // 'sent'`, is what makes NULL claimable at all) and must land on 'sent'.
  it('first send: protocol_email_status=NULL is claimable, sends, and the terminal write sets sent', async () => {
    const order = { id: 'o1', tenantId: 't1', customerEmail: 'buyer@x.bg', customerName: 'Иван', orderNumber: 42, protocolEmailStatus: null };
    const { db, handover, email, queue, updateCalls } = buildDeps(order, [{ id: 'o1' }]);

    const svc = new OrderProtocolEmailService(db, handover as any, email as any, queue as any);
    const result = await svc.sendProtocolEmail('t1', 'o1');

    expect(result).toEqual({ ok: true });
    expect(email.sendMailNow).toHaveBeenCalledTimes(1);
    expect(updateCalls).toContainEqual(
      expect.objectContaining({ protocolEmailStatus: 'sending' }),
    );
    expect(updateCalls).toContainEqual(
      expect.objectContaining({ protocolEmailStatus: 'sent', protocolEmailError: null }),
    );
  });
});

describe('OrderProtocolEmailService.enqueueProtocolEmail', () => {
  it('adds a job to PROTOCOL_EMAIL_QUEUE with a stable per-order jobId and returns without touching email/handover at all', async () => {
    const order = { id: 'o1', tenantId: 't1', customerEmail: 'buyer@x.bg', customerName: 'Иван', orderNumber: 42, protocolEmailStatus: null };
    const { db, handover, email, queue } = buildDeps(order);
    const svc = new OrderProtocolEmailService(db, handover as any, email as any, queue as any);

    await svc.enqueueProtocolEmail('t1', 'o1');

    expect(queue.add).toHaveBeenCalledWith(
      'send-protocol-email',
      { tenantId: 't1', orderId: 'o1' },
      expect.objectContaining({ jobId: 'protocol-o1' }),
    );
    expect(email.sendMailNow).not.toHaveBeenCalled();
    expect(handover.ensureDraftTarget).not.toHaveBeenCalled();
    expect(db.select).not.toHaveBeenCalled();
  });
});
