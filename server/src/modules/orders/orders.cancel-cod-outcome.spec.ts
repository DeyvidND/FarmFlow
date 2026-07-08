/**
 * Regression coverage: cancelling a наложен-платеж (COD) order must also close
 * its money outcome (codOutcome → 'refused'), so the Плащания screen doesn't
 * need a second, separate «Отказана» click. This is NOT a fraud signal — an
 * operator cancel isn't the customer's fault — so it must skip
 * codRisk.recordManualRefusal, unlike the manual setCodOutcome() path.
 */
import { OrdersService } from './orders.service';

function makeSvc(opts: {
  prevStatus: string;
  claimedPaymentMethod: string | null;
  claimedCodOutcome: string | null;
}) {
  const prevChain: any = {};
  prevChain.from = () => prevChain;
  prevChain.where = () => prevChain;
  prevChain.limit = () => Promise.resolve([{ status: opts.prevStatus }]);

  const rowUpdateChain: any = {};
  rowUpdateChain.set = () => rowUpdateChain;
  rowUpdateChain.where = () => rowUpdateChain;
  rowUpdateChain.returning = () => Promise.resolve([{ id: 'order-1', status: 'cancelled' }]);

  const codOutcomeSetCalls: Array<Record<string, unknown>> = [];
  let txUpdateCallCount = 0;

  const cacheDel = jest.fn().mockResolvedValue(undefined);
  const catalogInvalidate = jest.fn().mockResolvedValue(undefined);
  const codRisk = { recordManualRefusal: jest.fn().mockResolvedValue(undefined) };

  const db: any = {
    select: jest.fn(() => prevChain),
    update: jest.fn(() => rowUpdateChain),
    transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx: any = {
        update: jest.fn(() => {
          txUpdateCallCount += 1;
          const isClaim = txUpdateCallCount === 1;
          return {
            set: jest.fn((vals: Record<string, unknown>) => {
              if (!isClaim) codOutcomeSetCalls.push(vals);
              return {
                where: jest.fn(() => ({
                  returning: jest.fn(() =>
                    Promise.resolve([
                      {
                        id: 'order-1',
                        paymentMethod: opts.claimedPaymentMethod,
                        codOutcome: opts.claimedCodOutcome,
                      },
                    ]),
                  ),
                })),
              };
            }),
          };
        }),
        select: jest.fn(() => ({
          from: jest.fn(() => ({
            where: jest.fn(() => Promise.resolve([])),
          })),
        })),
      };
      return fn(tx);
    }),
  };

  const cache: any = { del: cacheDel };
  const catalogCache: any = { invalidate: catalogInvalidate };
  const svc = new OrdersService(
    db,
    {} as any,
    {} as any,
    {} as any,
    cache,
    {} as any,
    codRisk as any,
    catalogCache,
  );

  jest.spyOn(svc as any, 'restoreAvailabilityWindows').mockResolvedValue(undefined);
  jest.spyOn(svc as any, 'restoreVariantStock').mockResolvedValue(false);

  return { svc, codOutcomeSetCalls, codRisk };
}

describe('OrdersService.updateStatus cancel branch — COD outcome cascade', () => {
  it('auto-closes a COD order as refused, without striking cod-risk', async () => {
    const { svc, codOutcomeSetCalls, codRisk } = makeSvc({
      prevStatus: 'confirmed',
      claimedPaymentMethod: 'cod',
      claimedCodOutcome: null,
    });

    await svc.updateStatus('order-1', 'tenant-1', { status: 'cancelled' } as any);

    expect(codOutcomeSetCalls).toHaveLength(1);
    expect(codOutcomeSetCalls[0]).toMatchObject({
      codOutcome: 'refused',
      codOutcomeReason: null,
      codOutcomeSource: 'auto-cancel',
    });
    expect(codRisk.recordManualRefusal).not.toHaveBeenCalled();
  });

  it('does not re-mark a COD order already refused', async () => {
    const { svc, codOutcomeSetCalls } = makeSvc({
      prevStatus: 'confirmed',
      claimedPaymentMethod: 'cod',
      claimedCodOutcome: 'refused',
    });

    await svc.updateStatus('order-1', 'tenant-1', { status: 'cancelled' } as any);

    expect(codOutcomeSetCalls).toHaveLength(0);
  });

  it('leaves an online-paid order alone (no codOutcome field to set)', async () => {
    const { svc, codOutcomeSetCalls } = makeSvc({
      prevStatus: 'confirmed',
      claimedPaymentMethod: 'online',
      claimedCodOutcome: null,
    });

    await svc.updateStatus('order-1', 'tenant-1', { status: 'cancelled' } as any);

    expect(codOutcomeSetCalls).toHaveLength(0);
  });
});
