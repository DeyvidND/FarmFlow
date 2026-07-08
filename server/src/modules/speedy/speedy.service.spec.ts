/**
 * Unit tests for SpeedyService.estimateShipping.
 * The service is instantiated with stub deps; private fields (client, cache,
 * loadStored, resolveCreds) are overridden per-test via (svc as any).
 */
import { SpeedyService } from './speedy.service';
import { Logger } from '@nestjs/common';

// Silence NestJS logger output during tests.
jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

/** Minimal stub to satisfy the constructor without touching real DI. */
function makeService(): SpeedyService {
  const db = {} as any;
  const config = { get: (_k: string, d: any) => d } as any;
  const cache = { get: jest.fn(), set: jest.fn(), del: jest.fn() } as any;
  const client = { call: jest.fn() } as any;
  const codRisk = {} as any;
  const shipmentEmail = { sendShipped: jest.fn() } as any;
  return new SpeedyService(db, config, cache, client, codRisk, shipmentEmail);
}

describe('SpeedyService.estimateShipping', () => {
  let svc: SpeedyService;

  beforeEach(() => {
    svc = makeService();
  });

  it('returns null when speedy is not configured', async () => {
    (svc as any).loadStored = jest.fn().mockResolvedValue({ speedy: { configured: false } });
    const result = await svc.estimateShipping('t1', { siteId: 100 });
    expect(result).toBeNull();
  });

  it('returns null when siteId is falsy', async () => {
    (svc as any).loadStored = jest.fn().mockResolvedValue({ speedy: { configured: true } });
    const result = await svc.estimateShipping('t1', { siteId: 0 });
    expect(result).toBeNull();
  });

  it('returns cached value without calling the API', async () => {
    (svc as any).loadStored = jest.fn().mockResolvedValue({ speedy: { configured: true } });
    const cache = { get: jest.fn().mockResolvedValue(1500), set: jest.fn() };
    (svc as any).cache = cache;
    const callMock = jest.fn();
    (svc as any).client = { call: callMock };

    const result = await svc.estimateShipping('t1', { siteId: 100 });
    expect(result).toBe(1500);
    expect(callMock).not.toHaveBeenCalled();
  });

  it('calls /calculate and returns stotinki (EUR × 100)', async () => {
    (svc as any).loadStored = jest.fn().mockResolvedValue({
      speedy: { configured: true, defaultServiceId: 505 },
    });
    (svc as any).resolveCreds = jest.fn().mockResolvedValue({ base: 'x', userName: 'u', password: 'p' });
    const cache = { get: jest.fn().mockResolvedValue(null), set: jest.fn() };
    (svc as any).cache = cache;
    const call = jest.fn().mockResolvedValue({ calculations: [{ serviceId: 505, price: { total: 8.5, currency: 'EUR' } }] });
    (svc as any).client = { call };

    const result = await svc.estimateShipping('t1', { siteId: 100, weightGrams: 1500 });
    expect(result).toBe(850);
    expect(call).toHaveBeenCalledWith(
      expect.anything(),
      'calculate',
      expect.any(Object),
      6000,
    );
  });

  it('returns null when the API returns 0 price', async () => {
    (svc as any).loadStored = jest.fn().mockResolvedValue({
      speedy: { configured: true },
    });
    (svc as any).resolveCreds = jest.fn().mockResolvedValue({ base: 'x', userName: 'u', password: 'p' });
    const cache = { get: jest.fn().mockResolvedValue(null), set: jest.fn() };
    (svc as any).cache = cache;
    (svc as any).client = { call: jest.fn().mockResolvedValue({ calculations: [{ price: { total: 0 } }] }) };

    const result = await svc.estimateShipping('t1', { siteId: 100 });
    expect(result).toBeNull();
  });

  it('returns null on exception (never throws)', async () => {
    (svc as any).loadStored = jest.fn().mockRejectedValue(new Error('network error'));
    const result = await svc.estimateShipping('t1', { siteId: 100 });
    expect(result).toBeNull();
  });

  it('prices COD with a distinct cache key and passes cod to the request body', async () => {
    const call = jest.fn().mockResolvedValue({ calculations: [{ price: { total: 5 } }] });
    (svc as any).client = { call };
    (svc as any).loadStored = jest.fn().mockResolvedValue({
      speedy: { configured: true, defaultServiceId: 505 },
    });
    (svc as any).resolveCreds = jest.fn().mockResolvedValue({ base: 'x', userName: 'u', password: 'p' });
    const cache = { get: jest.fn().mockResolvedValue(null), set: jest.fn() };
    (svc as any).cache = cache;

    await svc.estimateShipping('t1', { siteId: 100, weightGrams: 1000, codAmountStotinki: 5000 });

    // Cache key must contain 'cod' so COD and non-COD prices are stored separately.
    expect(cache.set.mock.calls[0][0]).toContain('cod');
    // body is the 3rd arg (index 2) of client.call(creds, path, body, timeout)
    const body = call.mock.calls[0][2];
    // buildCalculateRequest puts COD under service.additionalServices.cod.amount,
    // and the destination under recipient.addressLocation (NOT recipient.address).
    expect((body as any).service?.additionalServices?.cod?.amount).toBeGreaterThan(0);
    expect((body as any).service?.serviceIds).toEqual([505]);
    expect((body as any).recipient?.addressLocation?.siteId).toBe(100);
  });
});

describe('SpeedyService.createLabelForOrder', () => {
  let svc: SpeedyService;

  beforeEach(() => {
    svc = makeService();
  });

  it('createLabelForOrder upserts an order-linked Speedy shipment', async () => {
    const call = jest.fn().mockResolvedValue({ id: 'S1', parcels: [{ barcode: 'BC1' }], price: { total: 4.2 } });
    (svc as any).client = { call };
    (svc as any).resolveCreds = jest.fn().mockResolvedValue({ base: 'x', userName: 'u', password: 'p' });
    (svc as any).loadStored = jest.fn().mockResolvedValue({ speedy: { configured: true, defaultServiceId: 505 } });
    (svc as any).searchSites = jest.fn().mockResolvedValue([{ id: 100 }]);
    (svc as any).orderForShipment = jest.fn().mockResolvedValue({
      tenantId: 't1', deliveryCity: 'Варна', customerName: 'И', customerPhone: '0888',
      deliveryAddress: 'ул', paymentMethod: 'cod', paidAt: null, totalStotinki: 5000,
    });

    // Mock db.insert(...).values(...).onConflictDoUpdate(...).returning()
    const returning = jest.fn().mockResolvedValue([{ carrier: 'speedy', carrierShipmentId: 'S1', trackingNumber: 'BC1', status: 'created' }]);
    const onConflictDoUpdate = jest.fn().mockReturnValue({ returning });
    const values = jest.fn().mockReturnValue({ onConflictDoUpdate });
    const insert = jest.fn().mockReturnValue({ values });
    const updWhere = jest.fn().mockResolvedValue(undefined);
    const updSet = jest.fn().mockReturnValue({ where: updWhere });
    const update = jest.fn().mockReturnValue({ set: updSet });
    // db.select(...).from(shipments).where(...).limit(1) — consolidation-master pre-read;
    // no existing draft row here → [] → unchanged (non-consolidated) codAmount path.
    const selLimit = jest.fn().mockResolvedValue([]);
    const selWhere = jest.fn().mockReturnValue({ limit: selLimit });
    const selFrom = jest.fn().mockReturnValue({ where: selWhere });
    const select = jest.fn().mockReturnValue({ from: selFrom });
    (svc as any).db = { insert, update, select };

    const row = await svc.createLabelForOrder('t1', 'order-1');
    expect(call).toHaveBeenCalledWith(expect.anything(), 'shipment', expect.anything());
    expect(insert).toHaveBeenCalled();
    expect(row.carrier).toBe('speedy');
  });

  it('finalizes a courier draft → Speedy ADDRESS waybill, stamps farmerId + orders.carrier=speedy', async () => {
    const call = jest.fn().mockResolvedValue({ id: 'S9', parcels: [{ barcode: 'BC9' }], price: { total: 5.5 } });
    (svc as any).client = { call };
    (svc as any).resolveCreds = jest.fn().mockResolvedValue({ base: 'x', userName: 'u', password: 'p' });
    (svc as any).loadStored = jest.fn().mockResolvedValue({ speedy: { configured: true, defaultServiceId: 505, defaultPackage: { weightKg: 2.5 } } });
    (svc as any).searchSites = jest.fn().mockResolvedValue([{ id: 200 }]);
    // A courier order carries its owning farmer_id (Phase-3 split).
    (svc as any).orderForShipment = jest.fn().mockResolvedValue({
      tenantId: 't1', farmerId: 'farmer-1', deliveryCity: 'Пловдив', customerName: 'Стоян', customerPhone: '0833',
      deliveryAddress: 'бул. България 12', paymentMethod: 'cod', paidAt: null, totalStotinki: 4200,
    });

    const returning = jest.fn().mockResolvedValue([{ carrier: 'speedy', farmerId: 'farmer-1', status: 'created' }]);
    const onConflictDoUpdate = jest.fn().mockReturnValue({ returning });
    const values = jest.fn().mockReturnValue({ onConflictDoUpdate });
    const insert = jest.fn().mockReturnValue({ values });
    const updWhere = jest.fn().mockResolvedValue(undefined);
    const updSet = jest.fn().mockReturnValue({ where: updWhere });
    const update = jest.fn().mockReturnValue({ set: updSet });
    // db.select(...).from(shipments).where(...).limit(1) — consolidation-master pre-read;
    // no existing draft row here → [] → unchanged (non-consolidated) codAmount path.
    const selLimit = jest.fn().mockResolvedValue([]);
    const selWhere = jest.fn().mockReturnValue({ limit: selLimit });
    const selFrom = jest.fn().mockReturnValue({ where: selWhere });
    const select = jest.fn().mockReturnValue({ from: selFrom });
    (svc as any).db = { insert, update, select };

    const row = await svc.createLabelForOrder('t1', 'order-1', 'farmer-1');

    // Always ADDRESS mode for Speedy (door); request body recipient = the door site.
    const body = call.mock.calls[0][2] as any;
    expect(body.recipient?.address?.siteId).toBe(200);
    expect(body.recipient?.pickupOfficeId).toBeUndefined();
    // farmerId stamped in BOTH insert values and update set.
    const insertVals = values.mock.calls[0][0];
    expect(insertVals.farmerId).toBe('farmer-1');
    expect(insertVals.carrier).toBe('speedy');
    const updateSet = onConflictDoUpdate.mock.calls[0][0].set;
    expect(updateSet.farmerId).toBe('farmer-1');
    expect(updateSet.carrier).toBe('speedy');
    // orders.carrier persisted = 'speedy'.
    expect(update).toHaveBeenCalled();
    expect(updSet.mock.calls[0][0]).toEqual({ carrier: 'speedy' });
    expect(row.carrier).toBe('speedy');
  });

  it('consolidation MASTER draft present → waybill collects the group-sum COD, not the order total', async () => {
    const call = jest.fn().mockResolvedValue({ id: 'S10', parcels: [{ barcode: 'BC10' }], price: { total: 5.5 } });
    (svc as any).client = { call };
    (svc as any).resolveCreds = jest.fn().mockResolvedValue({ base: 'x', userName: 'u', password: 'p' });
    (svc as any).loadStored = jest.fn().mockResolvedValue({ speedy: { configured: true, defaultServiceId: 505, defaultPackage: { weightKg: 2.5 } } });
    (svc as any).searchSites = jest.fn().mockResolvedValue([{ id: 200 }]);
    // The collector's own order total (500) is the smaller, distinguishable value —
    // if the override wired in c7d134e didn't take effect, the assertion below on
    // 1800 would fail against this 500.
    (svc as any).orderForShipment = jest.fn().mockResolvedValue({
      tenantId: 't1', farmerId: 'farmer-1', deliveryCity: 'Пловдив', customerName: 'Стоян', customerPhone: '0833',
      deliveryAddress: 'бул. България 12', paymentMethod: 'cod', paidAt: null, totalStotinki: 500,
    });

    const returning = jest.fn().mockResolvedValue([{ carrier: 'speedy', farmerId: 'farmer-1', status: 'created' }]);
    const onConflictDoUpdate = jest.fn().mockReturnValue({ returning });
    const values = jest.fn().mockReturnValue({ onConflictDoUpdate });
    const insert = jest.fn().mockReturnValue({ values });
    const updWhere = jest.fn().mockResolvedValue(undefined);
    const updSet = jest.fn().mockReturnValue({ where: updWhere });
    const update = jest.fn().mockReturnValue({ set: updSet });
    // db.select(...).from(shipments).where(...).limit(1) — this time a real MASTER row:
    // consolidationGroupId === id, holding the whole group's COD (1800).
    const selLimit = jest.fn().mockResolvedValue([{ id: 'ship-1', consolidationGroupId: 'ship-1', codAmountStotinki: 1800 }]);
    const selWhere = jest.fn().mockReturnValue({ limit: selLimit });
    const selFrom = jest.fn().mockReturnValue({ where: selWhere });
    const select = jest.fn().mockReturnValue({ from: selFrom });
    (svc as any).db = { insert, update, select };

    await svc.createLabelForOrder('t1', 'order-1', 'farmer-1');

    // The persisted COD must be the master's group sum (1800), NOT the order's own
    // total (500) — proves the live createLabelForOrder path actually applies the override.
    const insertVals = values.mock.calls[0][0];
    expect(insertVals.codAmountStotinki).toBe(1800);
    const updateSet = onConflictDoUpdate.mock.calls[0][0].set;
    expect(updateSet.codAmountStotinki).toBe(1800);
  });

  it('rejects finalizing another farmer\'s courier order (authz) before any carrier call', async () => {
    const call = jest.fn();
    (svc as any).client = { call };
    (svc as any).loadStored = jest.fn().mockResolvedValue({ speedy: { configured: true } });
    (svc as any).searchSites = jest.fn();
    // Order owned by farmer-1; caller is farmer-2.
    (svc as any).orderForShipment = jest.fn().mockResolvedValue({
      tenantId: 't1', farmerId: 'farmer-1', deliveryCity: 'Пловдив', deliveryAddress: 'x', paymentMethod: 'cod',
    });
    await expect(svc.createLabelForOrder('t1', 'order-1', 'farmer-2')).rejects.toThrow('друга ферма');
    expect(call).not.toHaveBeenCalled(); // no waybill created
  });
});

describe('SpeedyService farmer-scoped single-source decision', () => {
  let svc: SpeedyService;

  beforeEach(() => {
    svc = makeService();
  });

  it('listShipments returns [] for a farmer (Econt is the single source of the courier list)', async () => {
    // Must never touch the DB for a farmer — Econt owns the carrier-neutral courier queue.
    const select = jest.fn();
    (svc as any).db = { select };
    const out = await svc.listShipments('t1', 'farmer-1');
    expect(out).toEqual({ items: [], nextCursor: null });
    expect(select).not.toHaveBeenCalled();
  });

  it('codReconciliation returns [] for a farmer (single-source decision)', async () => {
    const select = jest.fn();
    const resolveCreds = jest.fn();
    (svc as any).db = { select };
    (svc as any).resolveCreds = resolveCreds;
    const out = await svc.codReconciliation('t1', 'farmer-1');
    expect(out).toEqual([]);
    expect(select).not.toHaveBeenCalled();
    expect(resolveCreds).not.toHaveBeenCalled();
  });
});

describe('SpeedyService farmer-ownership scoping (cross-farmer IDOR)', () => {
  let svc: SpeedyService;

  beforeEach(() => {
    svc = makeService();
  });

  /** db whose select().from().where().limit() resolves to `rows`. */
  function selectDb(rows: unknown[]) {
    const limit = jest.fn().mockResolvedValue(rows);
    const where = jest.fn().mockReturnValue({ limit });
    const from = jest.fn().mockReturnValue({ where });
    const select = jest.fn().mockReturnValue({ from });
    return { db: { select } as any, select };
  }

  describe('voidShipment', () => {
    it('cross-farmer id → NotFound, NO carrier cancel, NO delete', async () => {
      // farmer-2 asks to void a parcel owned by farmer-1: the scoped query finds nothing.
      const { db } = selectDb([]);
      const del = jest.fn();
      db.delete = del;
      (svc as any).db = db;
      const call = jest.fn();
      (svc as any).client = { call };
      (svc as any).resolveCreds = jest.fn();

      await expect(svc.voidShipment('t1', 'ship-1', 'farmer-2')).rejects.toThrow('Пратката не е намерена');
      expect(call).not.toHaveBeenCalled(); // no Speedy shipment/cancel
      expect(del).not.toHaveBeenCalled();  // no row deleted
    });

    it('owning farmer → cancels the waybill + deletes the row', async () => {
      const { db } = selectDb([{ id: 'ship-1', carrierShipmentId: 'S1' }]);
      const delWhere = jest.fn().mockResolvedValue(undefined);
      db.delete = jest.fn().mockReturnValue({ where: delWhere });
      (svc as any).db = db;
      const call = jest.fn().mockResolvedValue({});
      (svc as any).client = { call };
      (svc as any).resolveCreds = jest.fn().mockResolvedValue({ base: 'x', userName: 'u', password: 'p' });

      const out = await svc.voidShipment('t1', 'ship-1', 'farmer-1');
      expect(out).toEqual({ id: 'ship-1' });
      expect(call).toHaveBeenCalledTimes(1);       // shipment/cancel
      expect(db.delete).toHaveBeenCalledTimes(1);
    });

    it('admin (no farmerId) → tenant-wide delete still works', async () => {
      const { db } = selectDb([{ id: 'ship-1', carrierShipmentId: 'S1' }]);
      const delWhere = jest.fn().mockResolvedValue(undefined);
      db.delete = jest.fn().mockReturnValue({ where: delWhere });
      (svc as any).db = db;
      (svc as any).client = { call: jest.fn().mockResolvedValue({}) };
      (svc as any).resolveCreds = jest.fn().mockResolvedValue({ base: 'x', userName: 'u', password: 'p' });

      const out = await svc.voidShipment('t1', 'ship-1');
      expect(out).toEqual({ id: 'ship-1' });
      expect(db.delete).toHaveBeenCalledTimes(1);
    });
  });

  describe('getLabelPdf', () => {
    it('cross-farmer id → NotFound, NO label fetch', async () => {
      const { db } = selectDb([]);
      (svc as any).db = db;
      const callBinary = jest.fn();
      (svc as any).client = { callBinary };
      (svc as any).resolveCreds = jest.fn();

      await expect(svc.getLabelPdf('t1', 'ship-1', 'farmer-2')).rejects.toThrow('Пратката не е намерена');
      expect(callBinary).not.toHaveBeenCalled();
    });

    it('owning farmer → fetches the label PDF', async () => {
      const { db } = selectDb([{ id: 'S1', barcode: 'BC1' }]);
      (svc as any).db = db;
      const callBinary = jest.fn().mockResolvedValue(Buffer.from('PDF'));
      (svc as any).client = { callBinary };
      (svc as any).resolveCreds = jest.fn().mockResolvedValue({ base: 'x', userName: 'u', password: 'p' });

      const out = await svc.getLabelPdf('t1', 'ship-1', 'farmer-1');
      expect(out.toString()).toBe('PDF');
      expect(callBinary).toHaveBeenCalledTimes(1);
    });
  });

  describe('refreshStatus', () => {
    it('cross-farmer id → NotFound, NO track call', async () => {
      const { db } = selectDb([]);
      (svc as any).db = db;
      const refreshStatusForRow = jest.fn();
      (svc as any).refreshStatusForRow = refreshStatusForRow;

      await expect(svc.refreshStatus('t1', 'ship-1', 'farmer-2')).rejects.toThrow('Пратката не е намерена');
      expect(refreshStatusForRow).not.toHaveBeenCalled();
    });
  });

  describe('requestCourier', () => {
    it('only the farmer\'s own shipments are eligible (cross-farmer ids drop out)', async () => {
      // The scoped select returns ONLY farmer-1's shipment even though two ids were requested.
      const where = jest.fn().mockResolvedValue([{ id: 'ship-1', shipmentId: 'S1' }]);
      const from = jest.fn().mockReturnValue({ where });
      const select = jest.fn().mockReturnValue({ from });
      const updWhere = jest.fn().mockResolvedValue(undefined);
      const updSet = jest.fn().mockReturnValue({ where: updWhere });
      const update = jest.fn().mockReturnValue({ set: updSet });
      (svc as any).db = { select, update };
      (svc as any).resolveCreds = jest.fn().mockResolvedValue({ base: 'x', userName: 'u', password: 'p' });
      (svc as any).client = { call: jest.fn().mockResolvedValue({ id: 'PU1' }) };

      const out = await svc.requestCourier(
        't1',
        { shipmentIds: ['ship-1', 'ship-2-other-farmer'] } as never,
        'farmer-1',
      );
      // Only ship-1 matched the farmer scope and had a waybill → 1 attached, 1 skipped.
      expect(out.attached).toBe(1);
      expect(out.skipped).toBe(1);
    });
  });
});

describe('SpeedyService.maybeSeedSender (unit)', () => {
  const svc = new SpeedyService({} as never, { get: () => '' } as never, {} as never, {} as never, {} as never, { sendShipped: jest.fn() } as never);
  const seed = (speedy: unknown, farmName: string, contact: unknown, profiles: unknown) =>
    (svc as unknown as {
      maybeSeedSender: (s: any, n: string, c: any, p: any) => Record<string, unknown>;
    }).maybeSeedSender(speedy, farmName, contact, profiles);

  it('seeds sender when empty, from the contract client', () => {
    const out = seed({ userName: 'u' }, 'Ферма', { phone: '0700' },
      [{ name: 'Клиент', phone: '0888', clientNumber: '9' }]);
    expect(out.sender).toEqual({ contactName: 'Клиент', phone: '0888', mode: 'office' });
  });

  it('does NOT overwrite an existing sender', () => {
    const existing = { name: 'Ръчно', phone: '0999', mode: 'office' };
    const out = seed({ userName: 'u', sender: existing }, 'Ферма', { phone: '0700' }, []);
    expect(out.sender).toEqual(existing);
  });
});

/** Best-effort text rendering of a drizzle SQL AST (the object `and()`/`sql\`\`` build).
 *  Not a real SQL renderer — just enough to assert a guard clause's column/literal text
 *  is present, without hitting the circular PgColumn->PgTable refs that break JSON.stringify. */
function renderSqlAst(x: unknown, depth = 0): string {
  if (depth > 10 || x == null) return String(x);
  if (typeof x === 'string') return x;
  if (Array.isArray(x)) return x.map((c) => renderSqlAst(c, depth + 1)).join(' ');
  const obj = x as Record<string, unknown>;
  if (Array.isArray(obj.queryChunks)) return renderSqlAst(obj.queryChunks, depth + 1);
  if (typeof obj.name === 'string') return `col:${obj.name}`; // PgColumn
  if ('value' in obj) return renderSqlAst(obj.value, depth + 1);
  return '';
}

describe('syncOrderCodOutcome (speedy)', () => {
  /** db whose update(orders).set(...).where(...).returning(...) resolves to one
   *  written row (the no-clobber guard matched) by default. Callers read
   *  `set.mock.calls[0][0]` (the payload passed to .set()) after awaiting the call.
   *  `cache.del` is a spy so the payments-cache-bust wiring can be asserted too. */
  function makeSvcWithDbSpy(returningResult: unknown[] = [{ id: 'o1', tenantId: 't1' }]) {
    const svc = makeService();
    const del = jest.fn().mockResolvedValue(undefined);
    (svc as any).cache = { del };
    const returning = jest.fn().mockResolvedValue(returningResult);
    const where = jest.fn((..._args: unknown[]) => ({ returning }));
    const set = jest.fn((_payload: Record<string, unknown>) => ({ where }));
    const update = jest.fn(() => ({ set }));
    (svc as any).db = { update };
    return { svc, update, set, where, returning, del };
  }

  it('sets received when COD collected', async () => {
    const { svc, set } = makeSvcWithDbSpy();
    const shipment = { orderId: 'o1', tenantId: 't1', codAmountStotinki: 1000, codCollectedAt: new Date(), status: 'delivered' } as any;
    await (svc as any).syncOrderCodOutcome(shipment);
    expect(set.mock.calls[0][0]).toMatchObject({ codOutcome: 'received', codOutcomeSource: 'courier' });
  });

  it('sets refused on a returned status', async () => {
    const { svc, set } = makeSvcWithDbSpy();
    const shipment = { orderId: 'o1', tenantId: 't1', codAmountStotinki: 1000, codCollectedAt: null, status: 'returned' } as any;
    await (svc as any).syncOrderCodOutcome(shipment);
    expect(set.mock.calls[0][0]).toMatchObject({ codOutcome: 'refused', codOutcomeSource: 'courier' });
  });

  it('does nothing for a non-COD shipment', async () => {
    const { svc, set, update } = makeSvcWithDbSpy();
    await (svc as any).syncOrderCodOutcome({ orderId: 'o1', tenantId: 't1', codAmountStotinki: null } as any);
    expect(set).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('includes a WHERE cod_outcome IS NULL guard on the update (no-clobber)', async () => {
    const { svc, where } = makeSvcWithDbSpy();
    const shipment = { orderId: 'o1', tenantId: 't1', codAmountStotinki: 1000, codCollectedAt: new Date(), status: 'delivered' } as any;
    await (svc as any).syncOrderCodOutcome(shipment);
    expect(where).toHaveBeenCalledTimes(1);
    const cond = where.mock.calls[0][0];
    expect(renderSqlAst(cond).toLowerCase()).toContain('cod_outcome');
    expect(renderSqlAst(cond).toLowerCase()).toContain('is null');
  });

  it('does nothing when orderId is missing (standalone shipment)', async () => {
    const { svc, update } = makeSvcWithDbSpy();
    await (svc as any).syncOrderCodOutcome({ orderId: null, tenantId: 't1', codAmountStotinki: 1000, codCollectedAt: new Date() } as any);
    expect(update).not.toHaveBeenCalled();
  });

  it('busts the payments cache when the no-clobber guard actually wrote a row', async () => {
    const { svc, del } = makeSvcWithDbSpy([{ id: 'o1', tenantId: 't1' }]);
    const shipment = { orderId: 'o1', tenantId: 't1', codAmountStotinki: 1000, codCollectedAt: new Date(), status: 'delivered' } as any;
    await (svc as any).syncOrderCodOutcome(shipment);
    expect(del).toHaveBeenCalledWith('payments:totals:t1', 'payments:list:t1:all', 'payments:list:t1:cod');
  });

  it('does not bust the payments cache when the guard matched no row (already had an outcome)', async () => {
    const { svc, del } = makeSvcWithDbSpy([]);
    const shipment = { orderId: 'o1', tenantId: 't1', codAmountStotinki: 1000, codCollectedAt: new Date(), status: 'delivered' } as any;
    await (svc as any).syncOrderCodOutcome(shipment);
    expect(del).not.toHaveBeenCalled();
  });
});

describe('SpeedyService.refreshStatusForRow — codCollectedAt stamping on delivered', () => {
  let svc: SpeedyService;

  beforeEach(() => {
    svc = makeService();
  });

  /** db whose update(shipments).set(...).where(...).returning() resolves to a row
   *  built from the .set() payload (so refreshStatusForRow's post-update reads see it),
   *  and captures every .set() payload passed to db.update(...) for assertions. */
  function dbCapturingSets(baseRow: Record<string, unknown>) {
    const setPayloads: Record<string, unknown>[] = [];
    const update = jest.fn((_table: unknown) =>
      ({
        set: jest.fn((payload: Record<string, unknown>) => {
          setPayloads.push(payload);
          return {
            where: jest.fn(() => ({
              returning: jest.fn().mockResolvedValue([{ ...baseRow, ...payload }]),
            })),
          };
        }),
      }),
    );
    return { db: { update } as any, setPayloads };
  }

  it('stamps codCollectedAt when the parsed status is delivered on a COD parcel with none yet', async () => {
    const row = {
      id: 'ship-1',
      tenantId: 't1',
      trackingNumber: 'BC1',
      codAmountStotinki: 1000,
      codCollectedAt: null,
      status: 'shipped',
      orderId: null,
      customerNotifiedAt: null,
      trackingJson: null,
    } as any;
    (svc as any).resolveCreds = jest.fn().mockResolvedValue({ base: 'x', userName: 'u', password: 'p' });
    // Last operation description drives parseTrackStatus → 'delivered'.
    (svc as any).client = { call: jest.fn().mockResolvedValue({ parcels: [{ operations: [{ description: 'Доставена пратка' }] }] }) };
    const { db, setPayloads } = dbCapturingSets(row);
    (svc as any).db = db;
    (svc as any).codRisk = { recordReturnIfApplicable: jest.fn().mockResolvedValue(undefined) };
    (svc as any).syncOrderCodOutcome = jest.fn().mockResolvedValue(undefined);

    await (svc as any).refreshStatusForRow(row);

    expect(setPayloads[0]).toMatchObject({ status: 'delivered' });
    expect(setPayloads[0].codCollectedAt).toBeInstanceOf(Date);
  });

  it('does NOT overwrite an existing codCollectedAt', async () => {
    const existing = new Date('2026-01-01T00:00:00.000Z');
    const row = {
      id: 'ship-1', tenantId: 't1', trackingNumber: 'BC1', codAmountStotinki: 1000,
      codCollectedAt: existing, status: 'shipped', orderId: null, customerNotifiedAt: null, trackingJson: null,
    } as any;
    (svc as any).resolveCreds = jest.fn().mockResolvedValue({ base: 'x', userName: 'u', password: 'p' });
    (svc as any).client = { call: jest.fn().mockResolvedValue({ parcels: [{ operations: [{ description: 'Доставена пратка' }] }] }) };
    const { db, setPayloads } = dbCapturingSets(row);
    (svc as any).db = db;
    (svc as any).codRisk = { recordReturnIfApplicable: jest.fn().mockResolvedValue(undefined) };
    (svc as any).syncOrderCodOutcome = jest.fn().mockResolvedValue(undefined);

    await (svc as any).refreshStatusForRow(row);

    expect(setPayloads[0].codCollectedAt).toBe(existing);
  });

  it('does NOT stamp codCollectedAt for a non-COD parcel', async () => {
    const row = {
      id: 'ship-1', tenantId: 't1', trackingNumber: 'BC1', codAmountStotinki: null,
      codCollectedAt: null, status: 'shipped', orderId: null, customerNotifiedAt: null, trackingJson: null,
    } as any;
    (svc as any).resolveCreds = jest.fn().mockResolvedValue({ base: 'x', userName: 'u', password: 'p' });
    (svc as any).client = { call: jest.fn().mockResolvedValue({ parcels: [{ operations: [{ description: 'Доставена пратка' }] }] }) };
    const { db, setPayloads } = dbCapturingSets(row);
    (svc as any).db = db;
    (svc as any).codRisk = { recordReturnIfApplicable: jest.fn().mockResolvedValue(undefined) };
    (svc as any).syncOrderCodOutcome = jest.fn().mockResolvedValue(undefined);

    await (svc as any).refreshStatusForRow(row);

    expect(setPayloads[0].codCollectedAt).toBeNull();
  });
});

describe('SpeedyService.buildSenderBlob (unit)', () => {
  const svc = new SpeedyService({} as never, { get: () => '' } as never, {} as never, {} as never, {} as never, { sendShipped: jest.fn() } as never);
  const build = (speedy: unknown, senders: unknown, activeId: string) =>
    (svc as unknown as {
      buildSenderBlob: (s: any, ss: any, a: string) => Record<string, unknown>;
    }).buildSenderBlob(speedy, senders, activeId);

  it('mirrors the active Speedy point (contactName) into sender + keeps creds', () => {
    const out = build(
      { userName: 'u', passwordEnc: 'enc', configured: true },
      [{ id: 'a', label: 'Основна', contactName: 'Х', mode: 'office', officeId: 1 },
       { id: 'b', label: 'Склад', contactName: 'Y', mode: 'office', officeId: 2 }],
      'b',
    );
    expect(out.userName).toBe('u');
    expect(out.activeSenderId).toBe('b');
    expect(out.sender).toEqual({ contactName: 'Y', mode: 'office', officeId: 2 });
  });
});
