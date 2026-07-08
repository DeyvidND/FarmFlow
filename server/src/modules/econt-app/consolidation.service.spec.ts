import { ConflictException } from '@nestjs/common';
import { ConsolidationService } from './consolidation.service';

function makeDb(deliveryCfg: unknown) {
  // Minimal drizzle-select stub: returns the tenant settings row for the cfg read.
  return {
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => [{ settings: { delivery: deliveryCfg } }] }),
      }),
    }),
  } as any;
}

describe('ConsolidationService.getSuggestions gating', () => {
  it('returns empty when the toggle is off', async () => {
    const svc = new ConsolidationService(makeDb({ consolidateCourier: false }));
    await expect(svc.getSuggestions('t1')).resolves.toEqual({ suggestions: [] });
  });
});

/**
 * Fake drizzle db for consolidate(): three sequential `select(...)` calls
 * (toggle cfg, member rows, collector settings) followed by one `transaction`
 * whose `tx.update(...)` calls are made in order (master, then children).
 */
function makeConsolidateDb(opts: {
  rows: unknown[];
  collectorFarmerId: string;
  masterClaimed: Array<{ id: string }>;
  childrenClaimed: Array<{ id: string }>;
}) {
  const selectMock = jest
    .fn()
    // 1) loadDeliveryCfg
    .mockImplementationOnce(() => ({
      from: () => ({
        where: () => ({ limit: async () => [{ settings: { delivery: { consolidateCourier: true } } }] }),
      }),
    }))
    // 2) member orders + shipments load
    .mockImplementationOnce(() => ({
      from: () => ({
        innerJoin: () => ({
          leftJoin: () => ({
            where: async () => opts.rows,
          }),
        }),
      }),
    }))
    // 3) loadSettings (collector carrier namespace)
    .mockImplementationOnce(() => ({
      from: () => ({
        where: () => ({
          limit: async () => [
            {
              settings: {
                delivery: {
                  farmers: { [opts.collectorFarmerId]: { econt: { configured: true } } },
                },
              },
            },
          ],
        }),
      }),
    }));

  const updateMock = jest
    .fn()
    // master update
    .mockImplementationOnce(() => ({
      set: () => ({ where: () => ({ returning: async () => opts.masterClaimed }) }),
    }))
    // children update
    .mockImplementationOnce(() => ({
      set: () => ({ where: () => ({ returning: async () => opts.childrenClaimed }) }),
    }));

  const tx = { update: updateMock };

  return {
    select: selectMock,
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(tx),
  } as unknown as ConstructorParameters<typeof ConsolidationService>[0];
}

describe('ConsolidationService.consolidate race guards', () => {
  const collectorFarmerId = 'farmer-1';
  const baseRows = [
    {
      shipmentId: 'ship-1',
      orderId: 'order-1',
      farmerId: collectorFarmerId,
      farmerName: 'Collector',
      status: 'draft',
      consolidationGroupId: null,
      econtNo: null,
      trackingNo: null,
      totalStotinki: 1000,
    },
    {
      shipmentId: 'ship-2',
      orderId: 'order-2',
      farmerId: 'farmer-2',
      farmerName: 'Other',
      status: 'draft',
      consolidationGroupId: null,
      econtNo: null,
      trackingNo: null,
      totalStotinki: 500,
    },
  ];

  it('aborts with ConflictException when the master lost a concurrent race', async () => {
    const db = makeConsolidateDb({
      rows: baseRows,
      collectorFarmerId,
      masterClaimed: [], // compare-and-set matched 0 rows — someone else changed it first
      childrenClaimed: [{ id: 'ship-2' }],
    });
    const svc = new ConsolidationService(db);
    await expect(
      svc.consolidate('t1', { collectorFarmerId, memberOrderIds: ['order-1', 'order-2'] }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('aborts with ConflictException when a child lost a concurrent race', async () => {
    const db = makeConsolidateDb({
      rows: baseRows,
      collectorFarmerId,
      masterClaimed: [{ id: 'ship-1' }],
      childrenClaimed: [], // child was claimed by a concurrent call/waybill creation first
    });
    const svc = new ConsolidationService(db);
    await expect(
      svc.consolidate('t1', { collectorFarmerId, memberOrderIds: ['order-1', 'order-2'] }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('ConsolidationService.unconsolidate race guards', () => {
  function makeUnconsolidateDb(opts: { masterClaimed: Array<{ id: string }> }) {
    const selectMock = jest
      .fn()
      // 1) master pre-check select
      .mockImplementationOnce(() => ({
        from: () => ({
          where: () => ({
            limit: async () => [
              {
                id: 'master-1',
                groupId: 'master-1',
                econtNo: null,
                trackingNo: null,
                orderId: 'order-1',
              },
            ],
          }),
        }),
      }))
      // 2) order lookup for ownCod
      .mockImplementationOnce(() => ({
        from: () => ({
          where: () => ({
            limit: async () => [{ total: 1500, method: 'cod', paidAt: null }],
          }),
        }),
      }));

    const updateMock = jest
      .fn()
      // children reset
      .mockImplementationOnce(() => ({
        set: () => ({ where: () => ({ returning: async () => [{ id: 'ship-2' }] }) }),
      }))
      // master reset (compare-and-set)
      .mockImplementationOnce(() => ({
        set: () => ({ where: () => ({ returning: async () => opts.masterClaimed }) }),
      }));

    const tx = { update: updateMock };

    return {
      select: selectMock,
      transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(tx),
    } as unknown as ConstructorParameters<typeof ConsolidationService>[0];
  }

  it('aborts with ConflictException when the master lost a concurrent unconsolidate race', async () => {
    const db = makeUnconsolidateDb({ masterClaimed: [] });
    const svc = new ConsolidationService(db);
    await expect(svc.unconsolidate('t1', 'master-1')).rejects.toBeInstanceOf(ConflictException);
  });

  it('succeeds when the master compare-and-set still matches', async () => {
    const db = makeUnconsolidateDb({ masterClaimed: [{ id: 'master-1' }] });
    const svc = new ConsolidationService(db);
    await expect(svc.unconsolidate('t1', 'master-1')).resolves.toEqual({ restored: 1 });
  });
});
