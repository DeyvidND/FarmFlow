import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { OrdersService } from './orders.service';

/** Same literal-text extraction as orders.status-scope.spec.ts's helper of the
 *  same name — enough to assert a WHERE clause contains a given fragment
 *  without a live DB. */
function literalText(node: unknown): string {
  const n = node as { queryChunks?: unknown[]; value?: unknown } | null;
  if (!n || typeof n !== 'object') return '';
  if (Array.isArray(n.value) && n.value.every((v) => typeof v === 'string')) {
    return (n.value as string[]).join('');
  }
  if (Array.isArray(n.queryChunks)) return n.queryChunks.map(literalText).join('');
  return '';
}

/**
 * OrdersService.setCodOutcome — the manual наложен-платеж outcome endpoint.
 * Mirrors the mocking style of orders.status-scope.spec.ts: a minimal chainable
 * `db` stub (select/update) plus stub collaborators for the deps setCodOutcome
 * doesn't exercise (maps/orderEmail/econt/carrierFulfillment).
 */
function makeSvc(opts: {
  prev: { paymentMethod: string; codOutcome: string | null } | undefined;
  updated?: Record<string, unknown> | undefined;
  codRisk?: { recordManualRefusal: jest.Mock };
}) {
  const updatedRow = opts.updated ?? {
    id: 'o1',
    tenantId: 't1',
    paymentMethod: 'cod',
    codOutcome: null,
    customerPhone: '0888000000',
  };
  const selectChain: any = {};
  selectChain.select = jest.fn(() => selectChain);
  selectChain.from = jest.fn(() => selectChain);
  selectChain.where = jest.fn(() => selectChain);
  selectChain.limit = jest.fn(() => Promise.resolve(opts.prev ? [opts.prev] : []));

  const updateChain: any = {};
  updateChain.update = jest.fn(() => updateChain);
  updateChain.set = jest.fn(() => updateChain);
  updateChain.where = jest.fn(() => updateChain);
  updateChain.returning = jest.fn(() => Promise.resolve([updatedRow]));

  const db: any = {
    select: selectChain.select,
    update: updateChain.update,
  };
  // select(...) and update(...) both return their own chains regardless of args.
  db.select = jest.fn(() => selectChain);
  db.update = jest.fn(() => updateChain);

  const cache = { del: jest.fn().mockResolvedValue(undefined) };
  const codRisk = opts.codRisk ?? { recordManualRefusal: jest.fn().mockResolvedValue(undefined) };

  const svc = new OrdersService(
    db as never,
    {} as never,
    {} as never,
    {} as never,
    cache as never,
    {} as never,
    codRisk as never,
    {} as never,
  );
  return { svc, db, cache, codRisk, updatedRow };
}

describe('OrdersService.setCodOutcome', () => {
  it('throws NotFoundException when the order does not exist / is out of tenant scope', async () => {
    const { svc } = makeSvc({ prev: undefined });
    await expect(
      svc.setCodOutcome('missing', 't1', { outcome: 'received' } as never),
    ).rejects.toThrow(NotFoundException);
  });

  it('throws BadRequestException for a non-COD order', async () => {
    const { svc } = makeSvc({ prev: { paymentMethod: 'online', codOutcome: null } });
    await expect(
      svc.setCodOutcome('o1', 't1', { outcome: 'received' } as never),
    ).rejects.toThrow(BadRequestException);
  });

  it('records a strike on the NULL→refused transition', async () => {
    const { svc, codRisk } = makeSvc({
      prev: { paymentMethod: 'cod', codOutcome: null },
      updated: { id: 'o1', tenantId: 't1', paymentMethod: 'cod', codOutcome: 'refused', customerPhone: '0888000000' },
    });
    await svc.setCodOutcome('o1', 't1', { outcome: 'refused', reason: 'не вдигна' } as never);
    expect(codRisk.recordManualRefusal).toHaveBeenCalledTimes(1);
  });

  it('does NOT record a strike on a refused→refused re-mark (idempotent)', async () => {
    const { svc, codRisk } = makeSvc({
      prev: { paymentMethod: 'cod', codOutcome: 'refused' },
      updated: { id: 'o1', tenantId: 't1', paymentMethod: 'cod', codOutcome: 'refused', customerPhone: '0888000000' },
    });
    await svc.setCodOutcome('o1', 't1', { outcome: 'refused' } as never);
    expect(codRisk.recordManualRefusal).not.toHaveBeenCalled();
  });

  it('does NOT record a strike on a received→refused transition (only NULL→refused strikes)', async () => {
    const { svc, codRisk } = makeSvc({
      prev: { paymentMethod: 'cod', codOutcome: 'received' },
      updated: { id: 'o1', tenantId: 't1', paymentMethod: 'cod', codOutcome: 'refused', customerPhone: '0888000000' },
    });
    // Per the brief's idempotency contract, only the NULL→refused transition ever
    // strikes — this documents that a received→refused change is NOT re-struck.
    await svc.setCodOutcome('o1', 't1', { outcome: 'refused' } as never);
    expect(codRisk.recordManualRefusal).not.toHaveBeenCalled();
  });

  it('does NOT record a strike when marking received', async () => {
    const { svc, codRisk } = makeSvc({ prev: { paymentMethod: 'cod', codOutcome: null } });
    await svc.setCodOutcome('o1', 't1', { outcome: 'received' } as never);
    expect(codRisk.recordManualRefusal).not.toHaveBeenCalled();
  });

  it('swallows a codRisk failure — the outcome write still succeeds (best-effort)', async () => {
    const codRisk = { recordManualRefusal: jest.fn().mockRejectedValue(new Error('boom')) };
    const { svc } = makeSvc({
      prev: { paymentMethod: 'cod', codOutcome: null },
      updated: { id: 'o1', tenantId: 't1', paymentMethod: 'cod', codOutcome: 'refused', customerPhone: '0888000000' },
      codRisk,
    });
    const row = await svc.setCodOutcome('o1', 't1', { outcome: 'refused' } as never);
    expect(row.codOutcome).toBe('refused');
    expect(codRisk.recordManualRefusal).toHaveBeenCalledTimes(1);
  });

  it('busts the payments cache after a successful write', async () => {
    const { svc, cache } = makeSvc({ prev: { paymentMethod: 'cod', codOutcome: null } });
    await svc.setCodOutcome('o1', 't1', { outcome: 'received' } as never);
    expect(cache.del).toHaveBeenCalled();
  });
});

// Producer-scoped variant: same IDOR gate as updateStatusForFarmer — every line
// item on the order must belong to the calling farmer.
describe('OrdersService.setCodOutcomeForFarmer ownership (multi-producer) guard', () => {
  function makeFarmerSvc(lineItems: Array<{ farmerId: string | null }>) {
    const chain: any = {};
    chain.select = jest.fn(() => chain);
    chain.from = jest.fn(() => chain);
    chain.innerJoin = jest.fn(() => chain);
    chain.where = jest.fn(() => Promise.resolve(lineItems));
    return new OrdersService(
      chain as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
  }

  it('rejects on a shared order with a co-producer line item', async () => {
    const svc = makeFarmerSvc([{ farmerId: 'farmer-1' }, { farmerId: 'farmer-2' }]);
    await expect(
      svc.setCodOutcomeForFarmer('o', 't', 'farmer-1', { outcome: 'received' } as never),
    ).rejects.toThrow(ForbiddenException);
  });

  it('rejects when no line items resolve (cross-tenant / not theirs)', async () => {
    const svc = makeFarmerSvc([]);
    await expect(
      svc.setCodOutcomeForFarmer('o', 't', 'farmer-1', { outcome: 'received' } as never),
    ).rejects.toThrow(ForbiddenException);
  });

  it('delegates to setCodOutcome when every line item belongs to the producer', async () => {
    const svc = makeFarmerSvc([{ farmerId: 'farmer-1' }, { farmerId: 'farmer-1' }]);
    const spy = jest
      .spyOn(svc as never as { setCodOutcome: (...a: unknown[]) => unknown }, 'setCodOutcome')
      .mockResolvedValue({ id: 'o' } as never);
    await svc.setCodOutcomeForFarmer('o', 't', 'farmer-1', { outcome: 'received' } as never);
    expect(spy).toHaveBeenCalledWith('o', 't', { outcome: 'received' });
  });

  // Finding #2: same NOT_BASKET_PARENT gap as updateStatusForFarmer — a
  // basket's own parent row (farmerId null) must be excluded from the
  // ownership WHERE clause, or a single-farmer basket order 403s the very
  // producer who owns every member. Captured rather than trusted, since the
  // passthrough mock above cannot see whether the real query filters it out.
  it('excludes a basket\'s own parent row from the ownership WHERE clause', async () => {
    const wheres: unknown[] = [];
    const chain: any = {};
    chain.select = jest.fn(() => chain);
    chain.from = jest.fn(() => chain);
    chain.innerJoin = jest.fn(() => chain);
    chain.where = jest.fn((w: unknown) => {
      wheres.push(w);
      return Promise.resolve([{ farmerId: 'farmer-1' }]);
    });
    const svc = new OrdersService(
      chain as never, {} as never, {} as never, {} as never,
      {} as never, {} as never, {} as never, {} as never,
    );
    jest.spyOn(svc as never as { setCodOutcome: (...a: unknown[]) => unknown }, 'setCodOutcome')
      .mockResolvedValue({ id: 'o' } as never);

    await svc.setCodOutcomeForFarmer('o', 't', 'farmer-1', { outcome: 'received' } as never);

    const rendered = literalText(wheres[0]);
    expect(rendered).toMatch(/bundle/i);
    expect(rendered).toMatch(/is null/i);
  });
});
