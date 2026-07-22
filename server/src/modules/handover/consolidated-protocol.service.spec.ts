import { and, eq, isNull } from 'drizzle-orm';
import { consolidatedProtocols } from '@fermeribg/db';
import { ConsolidatedProtocolService } from './consolidated-protocol.service';

const CHAIN_METHODS = [
  'select', 'from', 'where', 'innerJoin', 'leftJoin', 'limit', 'orderBy',
  'update', 'insert', 'returning', 'delete',
] as const;

function makeDb() {
  const queue: unknown[] = [];
  const calls: { values: unknown[]; where: unknown[]; set: unknown[] } = { values: [], where: [], set: [] };
  const step: any = {};
  for (const m of CHAIN_METHODS) step[m] = jest.fn(() => step);
  step.values = jest.fn((v: unknown) => { calls.values.push(v); return step; });
  step.where = jest.fn((c: unknown) => { calls.where.push(c); return step; });
  step.set = jest.fn((v: unknown) => { calls.set.push(v); return step; });
  step.then = (resolve: (v: unknown) => void, reject: (e: unknown) => void) => {
    const v = queue.shift();
    if (v instanceof Error) reject(v); else resolve(v);
  };
  const db: any = { queue: (v: unknown) => queue.push(v), calls };
  for (const m of CHAIN_METHODS) db[m] = jest.fn(() => step);
  db.execute = jest.fn(() => Promise.resolve(undefined));
  db.transaction = jest.fn((fn: (tx: unknown) => Promise<unknown>) => fn(db));
  return db;
}

function makeSvc(db: any, routing: any = {}, courierAssignment: any = {}) {
  return new ConsolidatedProtocolService(db, routing, courierAssignment);
}

describe('ConsolidatedProtocolService.ensureDraft', () => {
  it('returns the existing id without touching the transaction when a row already exists', async () => {
    const db = makeDb();
    db.queue([{ id: 'existing' }]); // fast-path pre-check finds one
    const svc = makeSvc(db);
    const res = await svc.ensureDraft('t1', '2026-07-22', 'day');
    expect(res).toEqual({ id: 'existing' });
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('assigns the next per-tenant doc_number under the advisory lock when none exists', async () => {
    const db = makeDb();
    db.queue([]);          // fast-path pre-check: none
    db.queue([]);          // in-tx re-check under the lock: none
    db.queue([{ max: 5 }]); // current max doc_number
    db.queue([{ id: 'cp1' }]); // insert ... returning
    const svc = makeSvc(db);
    const res = await svc.ensureDraft('t1', '2026-07-22', 'leg', 1);
    expect(res).toEqual({ id: 'cp1' });
    const inserted = db.calls.values[0] as any;
    expect(inserted.docNumber).toBe(6);
    expect(inserted.scope).toBe('leg');
    expect(inserted.legIndex).toBe(1);
    expect(inserted.status).toBe('draft');
  });

  it('day scope stores legIndex NULL even when called with no legIndex argument', async () => {
    const db = makeDb();
    db.queue([]); db.queue([]); db.queue([{ max: 0 }]); db.queue([{ id: 'cp1' }]);
    const svc = makeSvc(db);
    await svc.ensureDraft('t1', '2026-07-22', 'day');
    expect((db.calls.values[0] as any).legIndex).toBeNull();
  });

  it('rejects a leg scope request with no legIndex', async () => {
    const svc = makeSvc(makeDb());
    await expect(svc.ensureDraft('t1', '2026-07-22', 'leg')).rejects.toThrow(/лег/);
  });

  // The COALESCE(-1) unique index treats scope='day' rows as legIndex=-1 and
  // every scope='leg' row by its real legIndex. The app-level duplicate guard
  // must mirror that EXACT semantics (isNull for day, eq for leg) or a race
  // that slips past this guard would still be legal per the DB constraint but
  // wrongly rejected/accepted here. Assert the captured WHERE, not just the result.
  it('the day-scope duplicate check filters on legIndex IS NULL', async () => {
    const db = makeDb();
    db.queue([{ id: 'existing' }]);
    const svc = makeSvc(db);
    await svc.ensureDraft('t1', '2026-07-22', 'day');
    expect(db.calls.where[0]).toEqual(
      and(
        eq(consolidatedProtocols.tenantId, 't1'),
        eq(consolidatedProtocols.date, '2026-07-22'),
        eq(consolidatedProtocols.scope, 'day'),
        isNull(consolidatedProtocols.legIndex),
      ),
    );
  });

  it('the leg-scope duplicate check filters on legIndex = N, not IS NULL', async () => {
    const db = makeDb();
    db.queue([{ id: 'existing' }]);
    const svc = makeSvc(db);
    await svc.ensureDraft('t1', '2026-07-22', 'leg', 2);
    expect(db.calls.where[0]).toEqual(
      and(
        eq(consolidatedProtocols.tenantId, 't1'),
        eq(consolidatedProtocols.date, '2026-07-22'),
        eq(consolidatedProtocols.scope, 'leg'),
        eq(consolidatedProtocols.legIndex, 2),
      ),
    );
  });
});

describe('ConsolidatedProtocolService.listForDay', () => {
  it('returns a virtual day placeholder plus one virtual placeholder per active leg, when nothing is persisted yet', async () => {
    const db = makeDb();
    db.queue([]); // no persisted rows for the date
    const courierAssignment = {
      getAssignmentsForDay: jest.fn().mockResolvedValue([
        { accountId: 'u1', legIndex: 1 },
        { accountId: 'u2', legIndex: 0 },
      ]),
    };
    const svc = makeSvc(db, {}, courierAssignment);
    const out = await svc.listForDay('t1', '2026-07-22');
    expect(out).toEqual([
      { id: null, scope: 'day', legIndex: null, date: '2026-07-22', docNumber: null, status: null },
      { id: null, scope: 'leg', legIndex: 0, date: '2026-07-22', docNumber: null, status: null },
      { id: null, scope: 'leg', legIndex: 1, date: '2026-07-22', docNumber: null, status: null },
    ]);
  });

  it('returns a persisted row in place of its virtual placeholder', async () => {
    const db = makeDb();
    db.queue([{ id: 'cp-day', tenantId: 't1', scope: 'day', date: '2026-07-22', legIndex: null, docNumber: 3, status: 'signed' }]);
    const courierAssignment = { getAssignmentsForDay: jest.fn().mockResolvedValue([]) };
    const svc = makeSvc(db, {}, courierAssignment);
    const out = await svc.listForDay('t1', '2026-07-22');
    expect(out).toEqual([{ id: 'cp-day', scope: 'day', legIndex: null, date: '2026-07-22', docNumber: 3, status: 'signed' }]);
  });

  it('does not duplicate a leg that has no active courier — legs come ONLY from the assignment board', async () => {
    const db = makeDb();
    db.queue([]);
    const courierAssignment = { getAssignmentsForDay: jest.fn().mockResolvedValue([]) };
    const svc = makeSvc(db, {}, courierAssignment);
    const out = await svc.listForDay('t1', '2026-07-22');
    expect(out).toEqual([{ id: null, scope: 'day', legIndex: null, date: '2026-07-22', docNumber: null, status: null }]);
  });
});

describe('ConsolidatedProtocolService — scope resolution', () => {
  it("day scope resolves to every handover-ready order in the date's slots, regardless of delivery type", async () => {
    const db = makeDb();
    db.queue([{ id: 's1' }, { id: 's2' }]); // deliverySlots for the date
    db.queue([{ id: 'o1' }, { id: 'o2' }]); // orders in those slots
    const svc = makeSvc(db);
    const ids = await (svc as any).resolveScopeOrderIds('t1', '2026-07-22', 'day');
    expect(ids).toEqual(['o1', 'o2']);
  });

  it('day scope with no slots that day resolves to nothing, without querying orders', async () => {
    const db = makeDb();
    db.queue([]); // no slots
    const svc = makeSvc(db);
    const ids = await (svc as any).resolveScopeOrderIds('t1', '2026-07-22', 'day');
    expect(ids).toEqual([]);
    expect(db.select).toHaveBeenCalledTimes(1); // only the slot query ran
  });

  it("leg scope resolves to ONLY that courier's own stops, via getRoute", async () => {
    const routing = {
      getRoute: jest.fn().mockResolvedValue({
        routes: [
          { courierIndex: 0, stops: [{ id: 'order-A' }, { id: 'order-B' }] },
          { courierIndex: 1, stops: [{ id: 'order-C' }] },
        ],
      }),
    };
    const svc = makeSvc(makeDb(), routing);
    const ids = await (svc as any).resolveScopeOrderIds('t1', '2026-07-22', 'leg', 1);
    expect(ids).toEqual(['order-C']);
    expect(routing.getRoute).toHaveBeenCalledWith('t1', '2026-07-22', undefined, undefined, undefined, 'all');
  });

  it('leg scope with no stops for that leg resolves to nothing', async () => {
    const routing = { getRoute: jest.fn().mockResolvedValue({ routes: [{ courierIndex: 0, stops: [] }] }) };
    const svc = makeSvc(makeDb(), routing);
    const ids = await (svc as any).resolveScopeOrderIds('t1', '2026-07-22', 'leg', 0);
    expect(ids).toEqual([]);
  });
});

describe('ConsolidatedProtocolService — buildLiveRows', () => {
  it('aggregates cargo per farmer ACROSS multiple orders, and lists orders separately with their own items', async () => {
    const db = makeDb();
    db.queue([ // orders
      { id: 'o1', orderNumber: 5, deliveryAddress: 'гр. Варна, бул. Осми Приморски полк 1', deliveryCity: null, totalStotinki: 1000 },
      { id: 'o2', orderNumber: 6, deliveryAddress: null, deliveryCity: 'Русе', totalStotinki: 500 },
    ]);
    db.queue([ // order_items ⋈ products
      { orderId: 'o1', farmerId: 'f1', productName: 'Домати', variantLabel: null, quantity: 2, unit: 'кг', priceStotinki: 300 },
      { orderId: 'o2', farmerId: 'f1', productName: 'Домати', variantLabel: null, quantity: 3, unit: 'кг', priceStotinki: 300 },
      { orderId: 'o2', farmerId: 'f2', productName: 'Мед', variantLabel: null, quantity: 1, unit: 'бр', priceStotinki: 1200 },
    ]);
    db.queue([ // farmers
      { id: 'f1', name: 'Васил', legal: { name: 'ЕТ Васил' }, signaturePng: null },
      { id: 'f2', name: 'Мария', legal: null, signaturePng: null },
    ]);
    const svc = makeSvc(db);
    const rows = await (svc as any).buildLiveRows('t1', ['o1', 'o2']);

    expect(rows.orders).toEqual([
      { orderId: 'o1', orderNumber: 5, customerCode: 'o1'.slice(0, 8).toUpperCase(), cityOrZone: 'Варна', items: [{ productName: 'Домати', variantLabel: undefined, quantity: 2, unit: 'кг', priceStotinki: 300 }], totalStotinki: 1000 },
      { orderId: 'o2', orderNumber: 6, customerCode: 'o2'.slice(0, 8).toUpperCase(), cityOrZone: 'Русе', items: [
        { productName: 'Домати', variantLabel: undefined, quantity: 3, unit: 'кг', priceStotinki: 300 },
        { productName: 'Мед', variantLabel: undefined, quantity: 1, unit: 'бр', priceStotinki: 1200 },
      ], totalStotinki: 500 },
    ]);
    // Farmer f1's cargo is the SUM across o1 (2кг) and o2 (3кг) — one row, not two.
    const f1 = rows.farmers.find((f: any) => f.farmerId === 'f1');
    expect(f1.items).toEqual([{ productName: 'Домати', variantLabel: undefined, quantity: 5, unit: 'кг', priceStotinki: 300 }]);
    expect(f1.legal).toEqual({ name: 'ЕТ Васил' });
    const f2 = rows.farmers.find((f: any) => f.farmerId === 'f2');
    expect(f2.name).toBe('Мария'); // falls back to plain name when legal is unset
  });

  it('returns empty sections for an empty order-id list, without querying the DB', async () => {
    const db = makeDb();
    const svc = makeSvc(db);
    const rows = await (svc as any).buildLiveRows('t1', []);
    expect(rows).toEqual({ farmers: [], orders: [] });
    expect(db.select).not.toHaveBeenCalled();
  });

  it("decrypts each farmer's saved signature", async () => {
    const { encryptSignature } = require('../../common/crypto/signature-crypto');
    process.env.ENCRYPTION_KEY = 'test-key';
    const db = makeDb();
    db.queue([{ id: 'o1', orderNumber: 1, deliveryAddress: null, deliveryCity: null, totalStotinki: 100 }]);
    db.queue([{ orderId: 'o1', farmerId: 'f1', productName: 'Домати', variantLabel: null, quantity: 1, unit: 'кг', priceStotinki: 100 }]);
    db.queue([{ id: 'f1', name: 'Васил', legal: null, signaturePng: encryptSignature('data:image/png;base64,AAA', 'test-key') }]);
    const svc = makeSvc(db);
    const rows = await (svc as any).buildLiveRows('t1', ['o1']);
    expect(rows.farmers[0].signaturePng).toBe('data:image/png;base64,AAA');
  });
});

describe('ConsolidatedProtocolService — overrides layer', () => {
  it('excludedOrderIds removes the order from section Б AND subtracts its items from farmer cargo', async () => {
    const db = makeDb();
    db.queue([{ // the persisted row itself — getView selects this FIRST
      id: 'cp1', tenantId: 't1', scope: 'day', date: '2026-07-22', legIndex: null, docNumber: 1, status: 'draft',
      meta: {}, overrides: { excludedOrderIds: ['o2'] }, frozenRows: null, receiverSignaturePng: null, signedAt: null,
    }]);
    db.queue([{ id: 's1' }]); // slots for the date (getView → getLiveRows → resolveScopeOrderIds, day scope)
    db.queue([{ id: 'o1' }, { id: 'o2' }]); // orders in scope
    db.queue([ // orders detail — only o1 survives the exclusion filter
      { id: 'o1', orderNumber: 5, deliveryAddress: null, deliveryCity: null, totalStotinki: 300 },
    ]);
    db.queue([ // items — only o1's
      { orderId: 'o1', farmerId: 'f1', productName: 'Домати', variantLabel: null, quantity: 2, unit: 'кг', priceStotinki: 300 },
    ]);
    db.queue([{ id: 'f1', name: 'Васил', legal: null, signaturePng: null }]);
    const svc = makeSvc(db);
    // The stubbed db returns canned rows regardless of the actual WHERE values it's
    // called with (it doesn't parse SQL), so asserting only on view.rows would stay
    // green even if the exclusion filter were deleted — spy on buildLiveRows itself
    // to prove o2 was actually dropped from the id list BEFORE any query ran.
    const buildLiveRowsSpy = jest.spyOn(svc as any, 'buildLiveRows');
    const view = await svc.getView('t1', 'cp1');
    expect(buildLiveRowsSpy).toHaveBeenCalledWith('t1', ['o1']);
    expect(view.rows.orders.map((o) => o.orderId)).toEqual(['o1']);
    expect(view.rows.farmers[0].items[0].quantity).toBe(2); // NOT inflated by an excluded order's items
  });

  it('extraRows are appended to their own section', async () => {
    const db = makeDb();
    db.queue([{ // persisted row — selected FIRST
      id: 'cp1', tenantId: 't1', scope: 'day', date: '2026-07-22', legIndex: null, docNumber: 1, status: 'draft',
      meta: {}, overrides: { extraRows: [{ section: 'A', label: 'Ръчно добавен фермер', detail: '10кг картофи' }] },
      frozenRows: null, receiverSignaturePng: null, signedAt: null,
    }]);
    db.queue([]); // no slots → empty live rows, cheaply
    const svc = makeSvc(db);
    const view = await svc.getView('t1', 'cp1');
    expect(view.rows.farmers).toHaveLength(1);
    expect(view.rows.farmers[0]).toMatchObject({ name: 'Ръчно добавен фермер' });
  });

  it('fieldOverrides merges batch/eDoc/note onto the matching farmer/order row by key', async () => {
    const db = makeDb();
    db.queue([{ // persisted row — selected FIRST
      id: 'cp1', tenantId: 't1', scope: 'day', date: '2026-07-22', legIndex: null, docNumber: 1, status: 'draft',
      meta: {}, overrides: { fieldOverrides: { 'f:f1': { batch: 'Партида 12' }, 'o:o1': { note: 'Внимание — чупливо' } } },
      frozenRows: null, receiverSignaturePng: null, signedAt: null,
    }]);
    db.queue([{ id: 's1' }]);
    db.queue([{ id: 'o1' }]);
    db.queue([{ id: 'o1', orderNumber: 5, deliveryAddress: null, deliveryCity: null, totalStotinki: 300 }]);
    db.queue([{ orderId: 'o1', farmerId: 'f1', productName: 'Домати', variantLabel: null, quantity: 2, unit: 'кг', priceStotinki: 300 }]);
    db.queue([{ id: 'f1', name: 'Васил', legal: null, signaturePng: null }]);
    const svc = makeSvc(db);
    const view = await svc.getView('t1', 'cp1');
    expect(view.rows.farmers[0].batch).toBe('Партида 12');
    expect(view.rows.orders[0].note).toBe('Внимание — чупливо');
  });

  it('a late order (added to the day AFTER the protocol was created) shows up automatically — the view recomputes live, it does not read a stored snapshot', async () => {
    const db = makeDb();
    db.queue([{ // persisted row — selected FIRST
      id: 'cp1', tenantId: 't1', scope: 'day', date: '2026-07-22', legIndex: null, docNumber: 1, status: 'draft',
      meta: {}, overrides: {}, frozenRows: null, receiverSignaturePng: null, signedAt: null,
    }]);
    db.queue([{ id: 's1' }]);
    db.queue([{ id: 'o-late' }]); // an order that didn't exist when the protocol was drafted
    db.queue([{ id: 'o-late', orderNumber: 9, deliveryAddress: null, deliveryCity: null, totalStotinki: 200 }]);
    db.queue([{ orderId: 'o-late', farmerId: 'f1', productName: 'Ябълки', variantLabel: null, quantity: 1, unit: 'кг', priceStotinki: 200 }]);
    db.queue([{ id: 'f1', name: 'Васил', legal: null, signaturePng: null }]);
    const svc = makeSvc(db);
    const view = await svc.getView('t1', 'cp1');
    expect(view.rows.orders.map((o) => o.orderId)).toEqual(['o-late']);
  });

  it('a SIGNED protocol returns frozen_rows verbatim — it never touches orders/order_items again', async () => {
    const db = makeDb();
    const frozen = { farmers: [{ farmerId: 'f1', name: 'Васил', legal: null, items: [], signaturePng: null }], orders: [] };
    db.queue([{
      id: 'cp1', tenantId: 't1', scope: 'day', date: '2026-07-22', legIndex: null, docNumber: 1, status: 'signed',
      meta: {}, overrides: {}, frozenRows: frozen, receiverSignaturePng: null, signedAt: new Date('2026-07-22T06:00:00Z'),
    }]);
    const svc = makeSvc(db);
    const view = await svc.getView('t1', 'cp1');
    expect(view.rows).toEqual(frozen);
    expect(db.select).toHaveBeenCalledTimes(1); // only the row itself — no live recompute
  });
});

describe('ConsolidatedProtocolService.updateDraft', () => {
  it('merges meta and overrides onto the existing jsonb, not replacing them wholesale', async () => {
    const db = makeDb();
    db.queue([{ id: 'cp1', status: 'draft', meta: { vehicle: 'Форд' }, overrides: { excludedOrderIds: ['o1'] } }]);
    const svc = makeSvc(db);
    await svc.updateDraft('t1', 'cp1', { meta: { plate: 'В1234АВ' } });
    expect(db.calls.set[0]).toEqual({
      meta: { vehicle: 'Форд', plate: 'В1234АВ' },
      overrides: { excludedOrderIds: ['o1'] },
      updatedAt: expect.any(Date),
    });
  });

  it('rejects editing a SIGNED protocol', async () => {
    const db = makeDb();
    db.queue([{ id: 'cp1', status: 'signed', meta: {}, overrides: {} }]);
    const svc = makeSvc(db);
    await expect(svc.updateDraft('t1', 'cp1', { meta: { vehicle: 'Форд' } })).rejects.toThrow(/подписан/);
  });
});

describe('ConsolidatedProtocolService.sign', () => {
  const OLD_KEY = process.env.ENCRYPTION_KEY;
  beforeEach(() => { process.env.ENCRYPTION_KEY = 'test-key'; });
  afterAll(() => {
    if (OLD_KEY === undefined) delete process.env.ENCRYPTION_KEY; else process.env.ENCRYPTION_KEY = OLD_KEY;
  });

  it('freezes the current live rows into frozen_rows and flips status to signed', async () => {
    const db = makeDb();
    db.queue([{ id: 'cp1', tenantId: 't1', scope: 'day', date: '2026-07-22', legIndex: null, status: 'draft', overrides: {} }]); // row lookup
    db.queue([]); // resolveScopeOrderIds: no slots → empty live rows
    const svc = makeSvc(db);
    await svc.sign('t1', 'cp1', 'data:image/png;base64,SIGNED', 'driver');
    const updated = db.calls.set[0] as any;
    expect(updated.status).toBe('signed');
    expect(updated.frozenRows).toEqual({ farmers: [], orders: [] });
    expect(updated.signedAt).toBeInstanceOf(Date);
  });

  it('rejects signing an already-signed protocol', async () => {
    const db = makeDb();
    db.queue([{ id: 'cp1', tenantId: 't1', scope: 'day', date: '2026-07-22', legIndex: null, status: 'signed', overrides: {} }]);
    const svc = makeSvc(db);
    await expect(svc.sign('t1', 'cp1', null, 'admin')).rejects.toThrow(/вече/);
  });

  it("auto-fills the operator's saved signature for an admin signer who supplies none", async () => {
    const { encryptSignature, looksEncrypted, decryptSignature } = require('../../common/crypto/signature-crypto');
    const db = makeDb();
    db.queue([{ id: 'cp1', tenantId: 't1', scope: 'day', date: '2026-07-22', legIndex: null, status: 'draft', overrides: {} }]);
    db.queue([]); // live rows: no slots
    db.queue([{ operatorSignaturePng: encryptSignature('data:image/png;base64,OP', 'test-key') }]); // tenants row
    const svc = makeSvc(db);
    await svc.sign('t1', 'cp1', undefined, 'admin');
    const updated = db.calls.set[0] as any;
    expect(looksEncrypted(updated.receiverSignaturePng)).toBe(true);
    expect(decryptSignature(updated.receiverSignaturePng, 'test-key')).toBe('data:image/png;base64,OP');
  });

  it('does NOT auto-fill for a driver signer — a courier never has a saved signature to fall back to', async () => {
    const db = makeDb();
    db.queue([{ id: 'cp1', tenantId: 't1', scope: 'leg', date: '2026-07-22', legIndex: 0, status: 'draft', overrides: {} }]);
    const svc = makeSvc(db, { getRoute: jest.fn().mockResolvedValue({ routes: [] }) });
    // Spy proves the tenants table is never consulted for a driver signer — not just
    // that receiverSignaturePng happens to come out null (which a differently-broken
    // implementation could also produce by accident).
    const dbSelectCallsBefore = db.select.mock.calls.length;
    await svc.sign('t1', 'cp1', undefined, 'driver');
    const updated = db.calls.set[0] as any;
    expect(updated.receiverSignaturePng).toBeNull();
    // row lookup (1) + resolveScopeOrderIds via getRoute for leg scope (0 extra db.select
    // calls — leg scope uses routing.getRoute, not db) — so exactly 1 db.select total,
    // never a 2nd for tenants.operatorSignaturePng.
    expect(db.select.mock.calls.length - dbSelectCallsBefore).toBe(1);
  });
});

/** A view shape complete enough for renderConsolidatedProtocolPdf (mirrors
 *  consolidated-pdf.spec.ts's own `view()` fixture). */
const PDF_VIEW = {
  id: 'cp1', scope: 'day' as const, legIndex: null, date: '2026-07-22', docNumber: 9, status: 'draft' as const,
  meta: {}, overrides: {}, rows: { farmers: [], orders: [] }, receiverSignaturePng: null, signedAt: null,
};

describe('ConsolidatedProtocolService.renderPdf', () => {
  it("fetches the tenant's own display name and renders the view to a PDF buffer", async () => {
    const db = makeDb();
    db.queue([{ name: 'Ферма Стойчеви' }]); // tenants row
    const svc = makeSvc(db);
    const buf = await svc.renderPdf('t1', PDF_VIEW as any);
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('falls back to ФермериБГ when the tenant has no display name', async () => {
    const db = makeDb();
    db.queue([{ name: null }]);
    const svc = makeSvc(db);
    const buf = await svc.renderPdf('t1', PDF_VIEW as any);
    expect(buf.length).toBeGreaterThan(0);
  });
});
