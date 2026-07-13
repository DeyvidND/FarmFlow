import { BadRequestException } from '@nestjs/common';
import { OrdersService } from './orders.service';

/**
 * OrdersService.setCodOutcome — the `outcome: 'pending'` REVERT branch (Task #3).
 * Mirrors the mocking style of orders.cod-outcome.spec.ts: a minimal chainable
 * `db` stub (select/update) plus stub collaborators, but here we also assert on
 * the exact `.set(...)` payload and on the commission/codRisk undo calls.
 */
function makeSvc(opts: {
  prev: { paymentMethod: string; codOutcome: string | null; tenantId?: string; customerPhone?: string } | undefined;
  updated?: Record<string, unknown> | undefined;
  codRisk?: { recordManualRefusal: jest.Mock; undoManualRefusal: jest.Mock };
  commission?: { accrueForOrder: jest.Mock; voidForOrder: jest.Mock };
}) {
  const updatedRow = opts.updated ?? {
    id: 'o1',
    tenantId: 't1',
    paymentMethod: 'cod',
    codOutcome: null,
    codOutcomeAt: null,
    codOutcomeReason: null,
    customerPhone: '0888000000',
  };
  const selectChain: any = {};
  selectChain.select = jest.fn(() => selectChain);
  selectChain.from = jest.fn(() => selectChain);
  selectChain.where = jest.fn(() => selectChain);
  selectChain.limit = jest.fn(() => Promise.resolve(opts.prev ? [opts.prev] : []));

  const setSpy = jest.fn((..._args: unknown[]) => updateChain);
  const updateChain: any = {};
  updateChain.update = jest.fn(() => updateChain);
  updateChain.set = setSpy;
  updateChain.where = jest.fn(() => updateChain);
  updateChain.returning = jest.fn(() => Promise.resolve([updatedRow]));

  const db: any = {};
  db.select = jest.fn(() => selectChain);
  db.update = jest.fn(() => updateChain);

  const cache = { del: jest.fn().mockResolvedValue(undefined) };
  const codRisk = opts.codRisk ?? {
    recordManualRefusal: jest.fn().mockResolvedValue(undefined),
    undoManualRefusal: jest.fn().mockResolvedValue(undefined),
  };
  const commission = opts.commission ?? {
    accrueForOrder: jest.fn().mockResolvedValue(undefined),
    voidForOrder: jest.fn().mockResolvedValue(undefined),
  };

  const svc = new OrdersService(
    db as never,
    {} as never,
    {} as never,
    {} as never,
    cache as never,
    {} as never,
    codRisk as never,
    {} as never,
    commission as never,
  );
  return { svc, db, cache, codRisk, commission, updatedRow, setSpy, selectChain, updateChain };
}

// Flush the microtask queue so fire-and-forget `void this.commission?.xxx()`
// calls (not awaited by setCodOutcome) have a chance to run before assertions.
const flush = () => new Promise((r) => setImmediate(r));

describe('OrdersService.setCodOutcome — revert to pending (Task #3)', () => {
  it('writes codOutcome: null / codOutcomeAt: null on a COD order', async () => {
    const { svc, setSpy } = makeSvc({
      prev: { paymentMethod: 'cod', codOutcome: 'received' },
    });
    await svc.setCodOutcome('o1', 't1', { outcome: 'pending' } as never);
    expect(setSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        codOutcome: null,
        codOutcomeAt: null,
        codOutcomeReason: null,
        codOutcomeSource: 'manual',
      }),
    );
  });

  it('reverting a previously-received order voids commission and does NOT undo a cod-risk strike', async () => {
    const { svc, codRisk, commission } = makeSvc({
      prev: { paymentMethod: 'cod', codOutcome: 'received', tenantId: 't1', customerPhone: '0888000000' },
    });
    await svc.setCodOutcome('o1', 't1', { outcome: 'pending' } as never);
    await flush();
    expect(commission.voidForOrder).toHaveBeenCalledWith('o1', 't1');
    expect(codRisk.undoManualRefusal).not.toHaveBeenCalled();
  });

  it('reverting a previously-refused order undoes the cod-risk strike', async () => {
    const { svc, codRisk } = makeSvc({
      prev: { paymentMethod: 'cod', codOutcome: 'refused', tenantId: 't1', customerPhone: '0888000000' },
    });
    await svc.setCodOutcome('o1', 't1', { outcome: 'pending' } as never);
    expect(codRisk.undoManualRefusal).toHaveBeenCalledTimes(1);
    expect(codRisk.undoManualRefusal).toHaveBeenCalledWith(
      expect.objectContaining({ paymentMethod: 'cod', codOutcome: 'refused' }),
    );
  });

  it('throws BadRequestException reverting a non-COD order', async () => {
    const { svc } = makeSvc({ prev: { paymentMethod: 'online', codOutcome: null } });
    await expect(
      svc.setCodOutcome('o1', 't1', { outcome: 'pending' } as never),
    ).rejects.toThrow(BadRequestException);
  });

  it('a codRisk.undoManualRefusal failure is swallowed — the revert still succeeds', async () => {
    const codRisk = {
      recordManualRefusal: jest.fn().mockResolvedValue(undefined),
      undoManualRefusal: jest.fn().mockRejectedValue(new Error('boom')),
    };
    const { svc } = makeSvc({
      prev: { paymentMethod: 'cod', codOutcome: 'refused', tenantId: 't1', customerPhone: '0888000000' },
      codRisk,
    });
    const row = await svc.setCodOutcome('o1', 't1', { outcome: 'pending' } as never);
    expect(row.codOutcome).toBe(null);
    expect(codRisk.undoManualRefusal).toHaveBeenCalledTimes(1);
  });

  it('busts the payments cache after a successful revert', async () => {
    const { svc, cache } = makeSvc({ prev: { paymentMethod: 'cod', codOutcome: 'received' } });
    await svc.setCodOutcome('o1', 't1', { outcome: 'pending' } as never);
    expect(cache.del).toHaveBeenCalled();
  });

  it('a lost race (concurrent revert already won) skips undoManualRefusal', async () => {
    // The conditional UPDATE's `.returning()` resolves empty — another request
    // already flipped this order out of 'refused' first — so this request must
    // NOT double-undo the cod-risk strike. It should instead re-select the
    // (already-consistent) current row and return that.
    const prevRow = { paymentMethod: 'cod', codOutcome: 'refused', tenantId: 't1', customerPhone: '0888000000' };
    const { svc, selectChain, updateChain, codRisk } = makeSvc({ prev: prevRow });

    const reselectRow = {
      id: 'o1',
      tenantId: 't1',
      paymentMethod: 'cod',
      codOutcome: null,
      codOutcomeAt: null,
      codOutcomeReason: null,
      customerPhone: '0888000000',
    };
    // 1st `.limit()` call = the initial `prev` fetch; 2nd = the race-loss re-fetch.
    (selectChain.limit as jest.Mock)
      .mockResolvedValueOnce([prevRow])
      .mockResolvedValueOnce([reselectRow]);
    // The conditional revert UPDATE loses the race — `.returning()` comes back empty.
    (updateChain.returning as jest.Mock).mockResolvedValueOnce([]);

    const row = await svc.setCodOutcome('o1', 't1', { outcome: 'pending' } as never);
    expect(codRisk.undoManualRefusal).not.toHaveBeenCalled();
    expect(row.codOutcome).toBe(null);
  });
});
