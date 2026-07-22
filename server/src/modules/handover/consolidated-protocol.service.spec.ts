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

function makeSvc(db: any, routing: any = {}, courierAssignment: any = {}, email: any = {}) {
  return new ConsolidatedProtocolService(db, routing, courierAssignment, email);
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

  it("keeps each farmer's saved signature ENCRYPTED — plaintext is produced only at render, never in the view or frozen_rows", async () => {
    const { encryptSignature, looksEncrypted } = require('../../common/crypto/signature-crypto');
    process.env.ENCRYPTION_KEY = 'test-key';
    const cipher = encryptSignature('data:image/png;base64,AAA', 'test-key');
    const db = makeDb();
    db.queue([{ id: 'o1', orderNumber: 1, deliveryAddress: null, deliveryCity: null, totalStotinki: 100 }]);
    db.queue([{ orderId: 'o1', farmerId: 'f1', productName: 'Домати', variantLabel: null, quantity: 1, unit: 'кг', priceStotinki: 100 }]);
    db.queue([{ id: 'f1', name: 'Васил', legal: null, signaturePng: cipher }]);
    const svc = makeSvc(db);
    const rows = await (svc as any).buildLiveRows('t1', ['o1']);
    // Ciphertext passthrough — this exact value is what sign() freezes into
    // frozen_rows and what getView returns in JSON, so it must be encrypted,
    // NOT the decrypted data-URL. (Decryption happens only in renderPdf.)
    expect(rows.farmers[0].signaturePng).toBe(cipher);
    expect(rows.farmers[0].signaturePng).not.toBe('data:image/png;base64,AAA');
    expect(looksEncrypted(rows.farmers[0].signaturePng)).toBe(true);
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

  it('IGNORES any fieldOverride key that is not batch/eDoc/note — no injecting legal/name/value into the signed PDF', async () => {
    const db = makeDb();
    db.queue([{ // an admin PATCH tries to smuggle name/legal/signature onto f1 and totalStotinki/customerCode onto o1
      id: 'cp1', tenantId: 't1', scope: 'day', date: '2026-07-22', legIndex: null, docNumber: 1, status: 'draft',
      meta: {}, overrides: { fieldOverrides: {
        'f:f1': { batch: 'OK', name: 'ХАКНАТО ИМЕ', legal: { name: 'фалшив ЕИК' }, signaturePng: 'data:evil' } as any,
        'o:o1': { note: 'OK', totalStotinki: 999999, customerCode: 'HACK' } as any,
      } },
      frozenRows: null, receiverSignaturePng: null, signedAt: null,
    }]);
    db.queue([{ id: 's1' }]);
    db.queue([{ id: 'o1' }]);
    db.queue([{ id: 'o1', orderNumber: 5, deliveryAddress: null, deliveryCity: null, totalStotinki: 300 }]);
    db.queue([{ orderId: 'o1', farmerId: 'f1', productName: 'Домати', variantLabel: null, quantity: 2, unit: 'кг', priceStotinki: 300 }]);
    db.queue([{ id: 'f1', name: 'Васил', legal: { name: 'ЕТ Васил' }, signaturePng: null }]);
    const svc = makeSvc(db);
    const view = await svc.getView('t1', 'cp1');
    const f1 = view.rows.farmers[0] as any;
    expect(f1.batch).toBe('OK'); // whitelisted field DOES apply
    expect(f1.name).toBe('Васил'); // injected name IGNORED — authoritative identity stands
    expect(f1.legal).toEqual({ name: 'ЕТ Васил' }); // injected legal IGNORED
    expect(f1.signaturePng).toBeNull(); // injected signature IGNORED
    const o1 = view.rows.orders[0] as any;
    expect(o1.note).toBe('OK');
    expect(o1.totalStotinki).toBe(300); // injected value IGNORED — authoritative order total stands
    expect(o1.customerCode).not.toBe('HACK');
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
    await svc.sign('t1', 'cp1', null, 'admin'); // the REAL client sends null (JSON.stringify keeps it), never undefined
    const updated = db.calls.set[0] as any;
    expect(looksEncrypted(updated.receiverSignaturePng)).toBe(true);
    expect(decryptSignature(updated.receiverSignaturePng, 'test-key')).toBe('data:image/png;base64,OP');
  });

  it('freezes farmer signatures ENCRYPTED into frozen_rows — a signed protocol never stores plaintext biometrics', async () => {
    const { encryptSignature, looksEncrypted } = require('../../common/crypto/signature-crypto');
    const cipher = encryptSignature('data:image/png;base64,FARMER', 'test-key');
    const db = makeDb();
    db.queue([{ id: 'cp1', tenantId: 't1', scope: 'day', date: '2026-07-22', legIndex: null, status: 'draft', overrides: {} }]); // row lookup
    db.queue([{ id: 's1' }]); // resolveScopeOrderIds: one slot
    db.queue([{ id: 'o1' }]); // one order in scope
    db.queue([{ id: 'o1', orderNumber: 1, deliveryAddress: null, deliveryCity: null, totalStotinki: 100 }]); // order detail
    db.queue([{ orderId: 'o1', farmerId: 'f1', productName: 'Домати', variantLabel: null, quantity: 1, unit: 'кг', priceStotinki: 100 }]); // items
    db.queue([{ id: 'f1', name: 'Васил', legal: null, signaturePng: cipher }]); // farmer with a saved (encrypted) signature
    const svc = makeSvc(db);
    await svc.sign('t1', 'cp1', 'data:image/png;base64,SIGNED', 'driver');
    const updated = db.calls.set[0] as any;
    // The farmer's signature is frozen as CIPHERTEXT — never the plaintext PNG.
    expect(updated.frozenRows.farmers[0].signaturePng).toBe(cipher);
    expect(looksEncrypted(updated.frozenRows.farmers[0].signaturePng)).toBe(true);
    expect(updated.frozenRows.farmers[0].signaturePng).not.toBe('data:image/png;base64,FARMER');
  });

  it('does NOT auto-fill for a driver signer — a courier never has a saved signature to fall back to', async () => {
    const db = makeDb();
    db.queue([{ id: 'cp1', tenantId: 't1', scope: 'leg', date: '2026-07-22', legIndex: 0, status: 'draft', overrides: {} }]);
    const svc = makeSvc(db, { getRoute: jest.fn().mockResolvedValue({ routes: [] }) });
    // Spy proves the tenants table is never consulted for a driver signer — not just
    // that receiverSignaturePng happens to come out null (which a differently-broken
    // implementation could also produce by accident).
    await svc.sign('t1', 'cp1', null, 'driver'); // client sends null; a driver still gets no auto-fill
    const updated = db.calls.set[0] as any;
    expect(updated.receiverSignaturePng).toBeNull();
    // Prove the tenants.operatorSignaturePng column is NEVER selected for a driver
    // signer — a differently-broken impl could also leave receiverSignaturePng null
    // by accident. (Asserting on the projection, not a raw select count, so the
    // archive render's own tenants.name select doesn't make this brittle.)
    const askedForOperatorSig = db.select.mock.calls.some(
      (c: any[]) => c[0] != null && typeof c[0] === 'object' && 'operatorSignaturePng' in c[0],
    );
    expect(askedForOperatorSig).toBe(false);
  });

  it('archives the rendered PDF bytes (base64) into pdf_archive at sign time', async () => {
    const db = makeDb();
    db.queue([{ id: 'cp1', tenantId: 't1', scope: 'day', date: '2026-07-22', legIndex: null, status: 'draft', overrides: {} }]); // row lookup
    db.queue([]); // live rows: no slots → empty
    db.queue([{ name: 'Ферма Стойчеви' }]); // renderPdf's tenant-name select (real render runs)
    const svc = makeSvc(db);
    await svc.sign('t1', 'cp1', 'data:image/png;base64,SIGNED', 'driver');
    const updated = db.calls.set[0] as any;
    expect(updated.status).toBe('signed');
    expect(typeof updated.pdfArchive).toBe('string');
    // The stored string is the ACTUAL rendered document — decode it, check the PDF magic bytes.
    expect(Buffer.from(updated.pdfArchive, 'base64').subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('leaves pdf_archive null but still flips status=signed when the render fails — a render hiccup never blocks a legal sign', async () => {
    const db = makeDb();
    db.queue([{ id: 'cp1', tenantId: 't1', scope: 'day', date: '2026-07-22', legIndex: null, status: 'draft', overrides: {} }]); // row lookup
    db.queue([]); // live rows: no slots
    const svc = makeSvc(db);
    jest.spyOn(svc, 'renderPdf').mockRejectedValue(new Error('pdfkit boom'));
    await svc.sign('t1', 'cp1', 'data:image/png;base64,SIGNED', 'driver');
    const updated = db.calls.set[0] as any;
    expect(updated.status).toBe('signed'); // the sign itself succeeds
    expect(updated.pdfArchive).toBeNull(); // archive degrades to null → getPdf will live-render
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

describe('ConsolidatedProtocolService.getPdf', () => {
  it('serves the ARCHIVED bytes for a signed protocol — byte-for-byte, never re-rendering', async () => {
    const db = makeDb();
    const archived = Buffer.from('%PDF-1.7 frozen-at-sign-bytes-âé');
    db.queue([{ pdfArchive: archived.toString('base64') }]); // pdf_archive select
    const svc = makeSvc(db);
    const renderSpy = jest.spyOn(svc, 'renderPdf');
    const buf = await svc.getPdf('t1', { ...PDF_VIEW, id: 'cp1', status: 'signed' } as any);
    expect(buf.equals(archived)).toBe(true);
    expect(renderSpy).not.toHaveBeenCalled(); // the whole point: a signed doc is served, not re-rendered
  });

  it('falls back to a live render for a signed protocol whose archive is null (legacy row)', async () => {
    const db = makeDb();
    db.queue([{ pdfArchive: null }]); // archive select — nothing stored
    db.queue([{ name: 'Ферма Стойчеви' }]); // renderPdf tenant-name select
    const svc = makeSvc(db);
    const buf = await svc.getPdf('t1', { ...PDF_VIEW, id: 'cp1', status: 'signed' } as any);
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('renders live for a DRAFT and never reads the archive column', async () => {
    const db = makeDb();
    db.queue([{ name: 'Ферма Стойчеви' }]); // ONLY renderPdf's select — no archive lookup precedes it
    const svc = makeSvc(db);
    const buf = await svc.getPdf('t1', { ...PDF_VIEW, id: 'cp1', status: 'draft' } as any);
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(db.select).toHaveBeenCalledTimes(1); // proves no archive select ran before the render
  });
});

describe('ConsolidatedProtocolService.getCourierRecipients', () => {
  it('returns one recipient per active courier leg, sorted by legIndex, with the email joined from users', async () => {
    const db = makeDb();
    db.queue([
      { id: 'u-leg1', email: 'leg1@x.bg' },
      { id: 'u-leg0', email: 'leg0@x.bg' },
    ]); // users select — order deliberately NOT leg-sorted, to prove the service does the sorting
    db.queue([]); // leg rows: no courier-email status yet
    const courierAssignment = {
      getAssignmentsForDay: jest.fn().mockResolvedValue([
        { accountId: 'u-leg1', legIndex: 1 },
        { accountId: 'u-leg0', legIndex: 0 },
      ]),
    };
    const svc = makeSvc(db, {}, courierAssignment);

    const out = await svc.getCourierRecipients('t1', '2026-07-22');

    expect(out).toEqual([
      { legIndex: 0, name: 'Лег 1', email: 'leg0@x.bg', emailStatus: null, emailAt: null },
      { legIndex: 1, name: 'Лег 2', email: 'leg1@x.bg', emailStatus: null, emailAt: null },
    ]);
  });

  it('includes a courier with NO email on file as email: null — never omitted from the list', async () => {
    const db = makeDb();
    db.queue([{ id: 'u-has-email', email: 'has@x.bg' }]); // u-no-email has no row back from users
    db.queue([]); // leg rows: no courier-email status yet
    const courierAssignment = {
      getAssignmentsForDay: jest.fn().mockResolvedValue([
        { accountId: 'u-has-email', legIndex: 0 },
        { accountId: 'u-no-email', legIndex: 1 },
      ]),
    };
    const svc = makeSvc(db, {}, courierAssignment);

    const out = await svc.getCourierRecipients('t1', '2026-07-22');

    expect(out).toEqual([
      { legIndex: 0, name: 'Лег 1', email: 'has@x.bg', emailStatus: null, emailAt: null },
      { legIndex: 1, name: 'Лег 2', email: null, emailStatus: null, emailAt: null },
    ]);
  });

  it("surfaces each leg's courier-email status (sent/failed) from the leg protocol rows", async () => {
    const db = makeDb();
    db.queue([{ id: 'u0', email: 'a@x.bg' }, { id: 'u1', email: 'b@x.bg' }]); // users
    const at0 = new Date('2026-07-22T08:00:00Z');
    const at1 = new Date('2026-07-22T08:05:00Z');
    db.queue([
      { legIndex: 0, status: 'sent', at: at0 },
      { legIndex: 1, status: 'failed', at: at1 },
    ]); // leg rows carry the per-leg courier-email state
    const courierAssignment = {
      getAssignmentsForDay: jest.fn().mockResolvedValue([
        { accountId: 'u0', legIndex: 0 },
        { accountId: 'u1', legIndex: 1 },
      ]),
    };
    const svc = makeSvc(db, {}, courierAssignment);

    const out = await svc.getCourierRecipients('t1', '2026-07-22');

    expect(out).toEqual([
      { legIndex: 0, name: 'Лег 1', email: 'a@x.bg', emailStatus: 'sent', emailAt: at0 },
      { legIndex: 1, name: 'Лег 2', email: 'b@x.bg', emailStatus: 'failed', emailAt: at1 },
    ]);
  });

  it('returns an empty list — no users lookup at all — when nobody is assigned that day', async () => {
    const db = makeDb();
    const courierAssignment = { getAssignmentsForDay: jest.fn().mockResolvedValue([]) };
    const svc = makeSvc(db, {}, courierAssignment);

    const out = await svc.getCourierRecipients('t1', '2026-07-22');

    expect(out).toEqual([]);
    expect(db.select).not.toHaveBeenCalled();
  });
});

describe('ConsolidatedProtocolService.sendLegProtocolsToCouriers', () => {
  // ensureDraft's own DB-chain plumbing (advisory lock, doc_number assignment)
  // is already proven by the ensureDraft describe block above; these tests
  // stub it out (spyOn) so they exercise ONLY the new per-courier orchestration
  // (recipient resolution -> ensureDraft(leg) -> email.sendMailNow), not
  // ensureDraft's internals a second time.
  function setup(
    board: { accountId: string; legIndex: number }[],
    usersRows: { id: string; email: string }[],
    legRows: { legIndex: number; status: 'sent' | 'failed' | null; at: Date | null }[] = [],
  ) {
    const db = makeDb();
    db.queue(usersRows); // getCourierRecipients: users select
    db.queue(legRows); //   getCourierRecipients: per-leg courier-email state select
    const courierAssignment = { getAssignmentsForDay: jest.fn().mockResolvedValue(board) };
    const email = { sendMailNow: jest.fn().mockResolvedValue(undefined) };
    const svc = makeSvc(db, {}, courierAssignment, email);
    jest.spyOn(svc, 'ensureDraft').mockImplementation(
      async (_t: string, _d: string, _scope: string, legIndex?: number) => ({ id: `cp-leg-${legIndex}` }),
    );
    return { db, courierAssignment, email, svc };
  }

  it("sends EXACTLY one email per active courier, to THEIR OWN email, carrying THEIR OWN leg's protocol id — never another leg's", async () => {
    const { email, svc } = setup(
      [
        { accountId: 'u-a', legIndex: 0 },
        { accountId: 'u-b', legIndex: 1 },
      ],
      [
        { id: 'u-a', email: 'courierA@x.bg' },
        { id: 'u-b', email: 'courierB@x.bg' },
      ],
    );

    const report = await svc.sendLegProtocolsToCouriers('t1', '2026-07-22');

    expect(email.sendMailNow).toHaveBeenCalledTimes(2);
    const callFor = (to: string) => email.sendMailNow.mock.calls.find((c: any[]) => c[0].to === to)![0];

    const callA = callFor('courierA@x.bg');
    expect(callA.attachments).toEqual([
      { kind: 'consolidated-protocol', consolidatedProtocolId: 'cp-leg-0', tenantId: 't1' },
    ]);

    const callB = callFor('courierB@x.bg');
    expect(callB.attachments).toEqual([
      { kind: 'consolidated-protocol', consolidatedProtocolId: 'cp-leg-1', tenantId: 't1' },
    ]);
    // Leg isolation, made explicit: courier A's descriptor never carries B's id.
    expect(callA.attachments[0].consolidatedProtocolId).not.toBe(callB.attachments[0].consolidatedProtocolId);

    expect(report.sent).toEqual([
      { legIndex: 0, email: 'courierA@x.bg', ok: true },
      { legIndex: 1, email: 'courierB@x.bg', ok: true },
    ]);
    expect(report.failed).toEqual([]);
  });

  it('skips a courier with no email on file entirely — no send attempted, not reported as sent or failed', async () => {
    const { email, svc } = setup(
      [
        { accountId: 'u-a', legIndex: 0 },
        { accountId: 'u-no-email', legIndex: 1 },
      ],
      [{ id: 'u-a', email: 'courierA@x.bg' }],
    );

    const report = await svc.sendLegProtocolsToCouriers('t1', '2026-07-22');

    expect(email.sendMailNow).toHaveBeenCalledTimes(1);
    expect(email.sendMailNow).toHaveBeenCalledWith(expect.objectContaining({ to: 'courierA@x.bg' }));
    expect(report.sent).toEqual([{ legIndex: 0, email: 'courierA@x.bg', ok: true }]);
    expect(report.failed).toEqual([]);
    // The no-email courier still shows up in the recipient preview...
    expect(report.recipients).toContainEqual({ legIndex: 1, name: 'Лег 2', email: null, emailStatus: null, emailAt: null });
    // ...but never in sent or failed.
    expect(report.sent.some((r: { legIndex: number }) => r.legIndex === 1)).toBe(false);
    expect(report.failed.some((r: { legIndex: number }) => r.legIndex === 1)).toBe(false);
  });

  it('a mailer failure for ONE courier is reported in `failed` and does not stop the others from sending', async () => {
    const { email, svc } = setup(
      [
        { accountId: 'u-a', legIndex: 0 },
        { accountId: 'u-b', legIndex: 1 },
      ],
      [
        { id: 'u-a', email: 'courierA@x.bg' },
        { id: 'u-b', email: 'courierB@x.bg' },
      ],
    );
    email.sendMailNow.mockImplementation(async (opts: any) => {
      if (opts.to === 'courierA@x.bg') throw new Error('SMTP timeout');
    });

    const report = await svc.sendLegProtocolsToCouriers('t1', '2026-07-22');

    expect(report.failed).toEqual([{ legIndex: 0, email: 'courierA@x.bg', ok: false, error: 'SMTP timeout' }]);
    expect(report.sent).toEqual([{ legIndex: 1, email: 'courierB@x.bg', ok: true }]);
  });

  it('returns an empty report when nobody is assigned that day — no ensureDraft, no send', async () => {
    const { email, svc } = setup([], []);

    const report = await svc.sendLegProtocolsToCouriers('t1', '2026-07-22');

    expect(report).toEqual({ recipients: [], sent: [], failed: [] });
    expect(email.sendMailNow).not.toHaveBeenCalled();
  });

  it('persists courier_email_status=sent (with a timestamp, no error) on each successful leg', async () => {
    const { db, svc } = setup([{ accountId: 'u-a', legIndex: 0 }], [{ id: 'u-a', email: 'a@x.bg' }]);

    await svc.sendLegProtocolsToCouriers('t1', '2026-07-22');

    const sentSet = db.calls.set.find((s: any) => s.courierEmailStatus === 'sent') as any;
    expect(sentSet).toBeTruthy();
    expect(sentSet.courierEmailError).toBeNull();
    expect(sentSet.courierEmailAt).toBeInstanceOf(Date);
  });

  it('persists courier_email_status=failed WITH the error message when a leg mailer fails', async () => {
    const { db, email, svc } = setup([{ accountId: 'u-a', legIndex: 0 }], [{ id: 'u-a', email: 'a@x.bg' }]);
    email.sendMailNow.mockRejectedValue(new Error('SMTP boom'));

    await svc.sendLegProtocolsToCouriers('t1', '2026-07-22');

    const failedSet = db.calls.set.find((s: any) => s.courierEmailStatus === 'failed') as any;
    expect(failedSet).toBeTruthy();
    expect(failedSet.courierEmailError).toBe('SMTP boom');
  });

  it('onlyFailed=true skips a leg already marked sent — the delivered courier is NOT re-emailed', async () => {
    const { email, svc } = setup(
      [
        { accountId: 'u-a', legIndex: 0 },
        { accountId: 'u-b', legIndex: 1 },
      ],
      [
        { id: 'u-a', email: 'a@x.bg' },
        { id: 'u-b', email: 'b@x.bg' },
      ],
      [{ legIndex: 0, status: 'sent', at: new Date('2026-07-22T08:00:00Z') }], // leg 0 already delivered; leg 1 never sent
    );

    const report = await svc.sendLegProtocolsToCouriers('t1', '2026-07-22', { onlyFailed: true });

    // Capturing-mock proof: the ALREADY-sent courier (leg 0, a@x.bg) is never emailed again;
    // only the not-yet-delivered leg 1 goes out.
    expect(email.sendMailNow).toHaveBeenCalledTimes(1);
    expect(email.sendMailNow).toHaveBeenCalledWith(expect.objectContaining({ to: 'b@x.bg' }));
    expect(email.sendMailNow).not.toHaveBeenCalledWith(expect.objectContaining({ to: 'a@x.bg' }));
    expect(report.sent).toEqual([{ legIndex: 1, email: 'b@x.bg', ok: true }]);
  });
});
