import { Test, TestingModule } from '@nestjs/testing';
import { ProblemsService } from './problems.service';
import { PlatformService, type DeliveryOpsSummary } from './platform.service';
import { PlatformInsightsService } from './insights.service';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';

// ─── Mock DB builder — chainable select/join/where/group/having/order, with
// `limit` as the terminal await point (matches errorProblems' query shape),
// and update/insert for resolveProblem's transaction. ──────────────────────
function makeDb() {
  return {
    select: jest.fn().mockReturnThis(),
    from: jest.fn().mockReturnThis(),
    leftJoin: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    having: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockResolvedValue([]),
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    returning: jest.fn().mockResolvedValue([]),
    insert: jest.fn().mockReturnThis(),
    values: jest.fn().mockResolvedValue(undefined),
    transaction: jest.fn(),
  };
}

const emptyDeliveryOps: DeliveryOpsSummary = {
  shipments: { total: 0, drafts: 0, created: 0, shipped: 0, delivered: 0, returned: 0, refused: 0 },
  cod: { pendingStotinki: 0, collectedStotinki: 0, settledStotinki: 0, outstandingStotinki: 0 },
  stuckDrafts: [],
};

describe('ProblemsService', () => {
  let service: ProblemsService;
  let db: ReturnType<typeof makeDb>;
  let deliveryOps: jest.Mock;
  let insights: jest.Mock;

  beforeEach(async () => {
    db = makeDb();
    db.transaction.mockImplementation(async (cb: (tx: typeof db) => Promise<unknown>) => cb(db));
    deliveryOps = jest.fn().mockResolvedValue(emptyDeliveryOps);
    insights = jest.fn().mockResolvedValue({ totalFarms: 0, farms: [], signals: [], adoption: [] });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProblemsService,
        { provide: DB_TOKEN, useValue: db },
        { provide: PlatformService, useValue: { deliveryOps } },
        { provide: PlatformInsightsService, useValue: { insights } },
      ],
    }).compile();

    service = module.get(ProblemsService);
  });

  describe('resolveProblem', () => {
    it('updates the existing resolution row when one exists for (tenantId, path)', async () => {
      db.returning.mockResolvedValueOnce([{ id: 'existing-row' }]);

      await service.resolveProblem('tenant-1', '/orders');

      expect(db.update).toHaveBeenCalled();
      expect(db.set).toHaveBeenCalledWith(expect.objectContaining({ resolvedAt: expect.any(Date) }));
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('inserts a new resolution row when no existing row matches', async () => {
      db.returning.mockResolvedValueOnce([]);

      await service.resolveProblem('tenant-1', '/orders');

      expect(db.insert).toHaveBeenCalled();
      expect(db.values).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: 'tenant-1', path: '/orders', resolvedAt: expect.any(Date) }),
      );
    });

    it('matches platform-wide errors (tenantId null) without a tenant filter', async () => {
      db.returning.mockResolvedValueOnce([]);

      await service.resolveProblem(null, '/public/bootstrap');

      expect(db.values).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: null, path: '/public/bootstrap' }),
      );
    });

    it('returns { ok: true } on success', async () => {
      db.returning.mockResolvedValueOnce([{ id: 'x' }]);
      await expect(service.resolveProblem('tenant-1', '/orders')).resolves.toEqual({ ok: true });
    });
  });

  describe('problems() — error source', () => {
    it('maps error_events groups into high-severity server_error items', async () => {
      db.limit.mockResolvedValueOnce([
        {
          tenantId: 'tenant-1',
          tenantName: 'Чайка',
          path: '/orders',
          count: 7,
          lastAt: new Date('2026-07-12T10:00:00Z'),
          resolvedAt: null,
        },
      ]);

      const { items, notes } = await service.problems();

      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        severity: 'high',
        kind: 'server_error',
        tenantId: 'tenant-1',
        tenantName: 'Чайка',
        path: '/orders',
        count: 7,
        detail: '7 грешки за 48ч по /orders',
      });
      expect(notes).toBeUndefined();
    });

    it('caps at ERROR_TOP_N and adds a truncation note when more groups exist', async () => {
      const rows = Array.from({ length: 51 }, (_, i) => ({
        tenantId: `tenant-${i}`,
        tenantName: `Farm ${i}`,
        path: '/x',
        count: 51 - i,
        lastAt: new Date('2026-07-12T10:00:00Z'),
        resolvedAt: null,
      }));
      db.limit.mockResolvedValueOnce(rows);

      const { items, notes } = await service.problems();

      const errorItems = items.filter((i) => i.kind === 'server_error');
      expect(errorItems).toHaveLength(50);
      expect(notes?.some((n) => n.includes('топ 50'))).toBe(true);
    });
  });

  describe('problems() — insight source', () => {
    it('maps a farm signal to its BG title/severity via SIGNAL_MAP', async () => {
      insights.mockResolvedValueOnce({
        totalFarms: 1,
        farms: [{ id: 'tenant-1', name: 'Чайка' }],
        signals: [
          {
            tenantId: 'tenant-1',
            name: 'Чайка',
            slug: 'chayka',
            phone: null,
            email: null,
            maxSeverity: 3,
            signals: [{ key: 'empty_shop', label: 'Няма активни продукти от 30 дни', action: 'x', severity: 3 }],
          },
        ],
        adoption: [],
      });

      const { items } = await service.problems();

      expect(items).toContainEqual(
        expect.objectContaining({
          severity: 'high',
          kind: 'empty_shop',
          tenantId: 'tenant-1',
          tenantName: 'Чайка',
          title: 'Няма активни продукти',
          detail: 'Няма активни продукти от 30 дни',
        }),
      );
    });
  });

  describe('problems() — delivery source', () => {
    it('surfaces stuck courier drafts as med-severity items', async () => {
      deliveryOps.mockResolvedValueOnce({
        ...emptyDeliveryOps,
        stuckDrafts: [
          {
            farmerId: 'farmer-1',
            farmerName: 'Иван',
            tenantId: 'tenant-1',
            tenantName: 'Чайка',
            count: 3,
            oldestAt: new Date('2026-07-01T00:00:00Z'),
          },
        ],
      });

      const { items } = await service.problems();

      expect(items).toContainEqual(
        expect.objectContaining({ severity: 'med', kind: 'stuck_shipment', tenantId: 'tenant-1', count: 3 }),
      );
    });

    it('surfaces outstanding COD as a platform-wide low-severity note + item', async () => {
      deliveryOps.mockResolvedValueOnce({ ...emptyDeliveryOps, cod: { ...emptyDeliveryOps.cod, outstandingStotinki: 1500 } });

      const { items, notes } = await service.problems();

      expect(items).toContainEqual(
        expect.objectContaining({ severity: 'low', kind: 'cod_outstanding', tenantId: null }),
      );
      expect(notes?.some((n) => n.includes('COD') || n.includes('наложени платежи'))).toBe(true);
    });
  });

  describe('problems() — sorting', () => {
    it('ranks high severity before med before low, regardless of source order', async () => {
      db.limit.mockResolvedValueOnce([
        { tenantId: 't1', tenantName: 'A', path: '/x', count: 1, lastAt: new Date(), resolvedAt: null },
      ]);
      deliveryOps.mockResolvedValueOnce({
        ...emptyDeliveryOps,
        cod: { ...emptyDeliveryOps.cod, outstandingStotinki: 100 },
        stuckDrafts: [
          { farmerId: 'f1', farmerName: 'B', tenantId: 't2', tenantName: 'B Farm', count: 1, oldestAt: null },
        ],
      });

      const { items } = await service.problems();

      const kinds = items.map((i) => i.kind);
      expect(kinds.indexOf('server_error')).toBeLessThan(kinds.indexOf('stuck_shipment'));
      expect(kinds.indexOf('stuck_shipment')).toBeLessThan(kinds.indexOf('cod_outstanding'));
    });
  });
});
