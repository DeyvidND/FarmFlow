import { Test, TestingModule } from '@nestjs/testing';
import { deliverySlots } from '@fermeribg/db';
import { HandoverService } from './handover.service';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';

/**
 * Drizzle's `and(...)`/`eq(...)` build a tree of `SQL` nodes whose
 * `queryChunks` mix raw `StringChunk`s, `PgColumn` references, and `Param`
 * wrappers around bound values. Deep-equalling that tree is fragile, so we
 * walk it and pull out `{ column, value }` pairs for every `col = param`
 * leaf — same approach as order-scheduling.spec.ts's `extractBoundPairs`.
 */
function extractEqPairs(node: unknown): Array<{ column: string; value: unknown }> {
  const pairs: Array<{ column: string; value: unknown }> = [];
  let pendingColumn: string | null = null;

  function walk(n: any): void {
    if (n == null || typeof n !== 'object') return;
    const ctor = n.constructor?.name;
    if (ctor === 'PgColumn' || (typeof n.name === 'string' && n.table !== undefined)) {
      pendingColumn = n.name;
      return;
    }
    if (ctor === 'Param') {
      if (pendingColumn) {
        pairs.push({ column: pendingColumn, value: n.value });
        pendingColumn = null;
      }
      return;
    }
    if (Array.isArray(n.queryChunks)) {
      for (const c of n.queryChunks) walk(c);
    }
  }

  const sqlNode = (node as any)?.getSQL ? (node as any).getSQL() : node;
  walk(sqlNode);
  return pairs;
}

const CHAIN_METHODS = [
  'select', 'from', 'where', 'innerJoin', 'leftJoin', 'limit', 'orderBy',
  'update', 'insert', 'onConflictDoNothing', 'returning', 'delete',
] as const;

/** Thenable chainable Drizzle mock. `db` (the DI-injected root) is NOT itself
 *  thenable — only `step` (what every builder method returns) is, so
 *  NestJS's TestingModule.compile() never auto-unwraps the provider. Awaiting
 *  any chain built from `db` resolves the next queued value (FIFO). `calls`
 *  records values() and set() payloads for assertions. */
function makeDb() {
  const queue: unknown[] = [];
  const calls: { values: unknown[]; set: unknown[] } = { values: [], set: [] };

  const step: any = {};
  for (const m of CHAIN_METHODS) step[m] = jest.fn(() => step);
  step.values = jest.fn((v: unknown) => { calls.values.push(v); return step; });
  step.set = jest.fn((v: unknown) => { calls.set.push(v); return step; });
  step.then = (resolve: (v: unknown) => void, reject: (e: unknown) => void) => {
    const v = queue.shift();
    if (v instanceof Error) reject(v);
    else resolve(v);
  };

  const db: any = { queue: (v: unknown) => queue.push(v), calls };
  for (const m of CHAIN_METHODS) db[m] = jest.fn(() => step);
  return db;
}

async function build(db: any): Promise<HandoverService> {
  const mod: TestingModule = await Test.createTestingModule({
    providers: [HandoverService, { provide: DB_TOKEN, useValue: db }],
  }).compile();
  return mod.get(HandoverService);
}

describe('HandoverService.buildDraft farmer_to_operator', () => {
  it('aggregates one farmer\'s items across the slot and freezes both legal parties', async () => {
    const db = makeDb();
    db.queue([{ legal: { name: 'ЕТ Оператор', eik: '111' } }]);            // tenant settings.legal
    db.queue([{ id: 'f1', legal: { name: 'ЕТ Васил', eik: '203912345' } }]); // farmer
    db.queue([                                                                // order_items ⋈ products
      { productName: 'Домати', variantLabel: null, quantity: 2, unit: 'кг', priceStotinki: 300, orderNumber: 5 },
      { productName: 'Домати', variantLabel: null, quantity: 3, unit: 'кг', priceStotinki: 300, orderNumber: 7 },
      { productName: 'Краставици', variantLabel: null, quantity: 1, unit: 'бр', priceStotinki: 120, orderNumber: 5 },
    ]);
    const svc = await build(db);
    const draft = await svc.buildDraft('t1', { kind: 'farmer_to_operator', farmerId: 'f1', slotId: 's1' });
    expect(draft.from).toEqual({ name: 'ЕТ Васил', eik: '203912345' });
    expect(draft.to).toEqual({ name: 'ЕТ Оператор', eik: '111' });
    expect(draft.items).toEqual([
      { productName: 'Домати', variantLabel: undefined, quantity: 5, unit: 'кг', priceStotinki: 300, orderNumber: undefined },
      { productName: 'Краставици', variantLabel: undefined, quantity: 1, unit: 'бр', priceStotinki: 120, orderNumber: undefined },
    ]);
    expect(draft.total).toBe(5 * 300 + 1 * 120);
  });

  it('throws 400 when the farmer has no legal identity', async () => {
    const db = makeDb();
    db.queue([{ legal: { name: 'ЕТ Оператор' } }]); // tenant ok
    db.queue([{ id: 'f1', legal: null }]);          // farmer missing
    const svc = await build(db);
    await expect(svc.buildDraft('t1', { kind: 'farmer_to_operator', farmerId: 'f1', slotId: 's1' }))
      .rejects.toThrow(/фермер/);
  });
});

describe('HandoverService.buildDraft operator_to_customer', () => {
  it('uses the order items + customer identity; total is the COD amount', async () => {
    const db = makeDb();
    db.queue([{ legal: { name: 'ЕТ Оператор' } }]); // tenant settings.legal
    db.queue([{ id: 'o9', customerName: 'Иван Петров', customerPhone: '0888', deliveryAddress: 'ул. Роза 1', totalStotinki: 720 }]); // order
    db.queue([
      { productName: 'Домати', variantLabel: null, quantity: 2, priceStotinki: 300, unit: 'кг', name: 'Домати' },
      { productName: 'Краставици', variantLabel: null, quantity: 1, priceStotinki: 120, unit: 'бр', name: 'Краставици' },
    ]); // order_items ⋈ products (left join)
    const svc = await build(db);
    const draft = await svc.buildDraft('t1', { kind: 'operator_to_customer', orderId: 'o9' });
    expect(draft.from).toEqual({ name: 'ЕТ Оператор' });
    expect(draft.to).toEqual({ name: 'Иван Петров', phone: '0888', address: 'ул. Роза 1' });
    expect(draft.items.map((i) => i.quantity)).toEqual([2, 1]);
    expect(draft.items[0].unit).toBe('кг');
    expect(draft.total).toBe(720);
  });
});

describe('HandoverService.createSigned', () => {
  it('assigns the next per-tenant protocol_number and stores digital signatures', async () => {
    const db = makeDb();
    // buildDraft re-derivation (farmer leg):
    db.queue([{ legal: { name: 'ЕТ Оператор' } }]);
    db.queue([{ id: 'f1', legal: { name: 'ЕТ Васил' } }]);
    db.queue([{ productName: 'Домати', variantLabel: null, quantity: 5, unit: 'кг', priceStotinki: 300, orderNumber: 5 }]);
    db.queue([]);                                  // dup-check: none found
    db.queue([{ max: 40 }]);                       // current max protocol_number
    db.queue([{ id: 'p1', protocolNumber: 41 }]);  // insert ... returning
    const svc = await build(db);
    const res = await svc.createSigned('t1', {
      kind: 'farmer_to_operator', farmerId: 'f1', slotId: 's1',
      items: [{ productName: 'Домати', quantity: 5, priceStotinki: 300 }],
      fromSignaturePng: 'data:image/png;base64,AAA', toSignaturePng: 'data:image/png;base64,BBB',
    } as any);
    expect(res.protocolNumber).toBe(41);
    const inserted = db.calls.values[0] as any;
    expect(inserted.status).toBe('signed');
    expect(inserted.signMode).toBe('digital');
    expect(inserted.protocolNumber).toBe(41);
    expect(inserted.fromSnapshot).toEqual({ name: 'ЕТ Васил' });      // frozen, not client-supplied
    expect(inserted.totalStotinki).toBe(1500);                        // re-derived, not trusted from client
  });

  it('rejects a duplicate signed protocol for the same target', async () => {
    const db = makeDb();
    db.queue([{ legal: { name: 'ЕТ Оператор' } }]);
    db.queue([{ id: 'f1', legal: { name: 'ЕТ Васил' } }]);
    db.queue([{ productName: 'Домати', variantLabel: null, quantity: 1, unit: 'кг', priceStotinki: 300 }]);
    db.queue([{ id: 'dup' }]); // existing signed protocol found
    const svc = await build(db);
    await expect(svc.createSigned('t1', {
      kind: 'farmer_to_operator', farmerId: 'f1', slotId: 's1',
      items: [{ productName: 'Домати', quantity: 1, priceStotinki: 300 }],
    } as any)).rejects.toThrow(/вече/);
  });
});

describe('HandoverService.createBatch', () => {
  it('creates one row per uncovered target and skips already-covered ones', async () => {
    const db = makeDb();
    db.queue([{ farmerId: 'f1', slotId: 's1' }]);          // distinct farmer pickups for the slot
    db.queue([{ id: 'o1', slotId: 's1' }]);                // customer orders for the slot
    db.queue([{ max: 5 }]);                                // current max protocol_number
    db.queue([]);                                          // farmer target f1/s1: not covered
    db.queue([{ legal: { name: 'ЕТ Оператор' } }]);         // buildDraft: tenant
    db.queue([{ id: 'f1', legal: { name: 'ЕТ Васил' } }]);  // buildDraft: farmer
    db.queue([                                              // buildDraft: order_items ⋈ products
      { productName: 'Домати', variantLabel: null, quantity: 2, unit: 'кг', priceStotinki: 300 },
    ]);
    db.queue([{ id: 'p-new' }]);                            // insert ... returning
    db.queue([{ id: 'existing' }]);                         // customer target o1: already covered

    const svc = await build(db);
    const res = await svc.createBatch('t1', { slotId: 's1' } as any);

    expect(res.ids).toEqual(['p-new']);
    const inserted = db.calls.values[0] as any;
    expect(inserted.status).toBe('draft');
    expect(inserted.signMode).toBe('pending');
    expect(inserted.protocolNumber).toBe(6);
    expect(inserted.farmerId).toBe('f1');
  });

  it('is idempotent — a second run with all targets already covered creates zero rows', async () => {
    const db = makeDb();
    db.queue([{ farmerId: 'f1', slotId: 's1' }]);
    db.queue([{ id: 'o1', slotId: 's1' }]);
    db.queue([{ max: 6 }]);
    db.queue([{ id: 'p-new' }]);   // farmer target already covered
    db.queue([{ id: 'existing' }]); // customer target already covered

    const svc = await build(db);
    const res = await svc.createBatch('t1', { slotId: 's1' } as any);

    expect(res.ids).toEqual([]);
    expect(db.calls.values).toEqual([]);
  });
});

describe('HandoverService.markSigned', () => {
  it('flips pending → signed(paper) and rejects a second call', async () => {
    const db = makeDb();
    db.queue([{ id: 'p1', status: 'pending' }]); // load
    db.queue([{ id: 'p1' }]);                    // update returning
    const svc = await build(db);
    await svc.markSigned('t1', 'p1');
    const set = db.calls.set[0] as any;
    expect(set.status).toBe('signed');
    expect(set.signMode).toBe('paper');

    const db2 = makeDb();
    db2.queue([{ id: 'p1', status: 'signed' }]);
    const svc2 = await build(db2);
    await expect(svc2.markSigned('t1', 'p1')).rejects.toThrow(/подписан/);
  });
});

describe('HandoverService.list', () => {
  it('filters by tenant, slot, and kind', async () => {
    const db = makeDb();
    db.queue([{ id: 'p1', tenantId: 't1', slotId: 's1', kind: 'farmer_to_operator' }]);
    const svc = await build(db);
    const rows = await svc.list('t1', { slotId: 's1', kind: 'farmer_to_operator' });
    expect(rows).toEqual([{ id: 'p1', tenantId: 't1', slotId: 's1', kind: 'farmer_to_operator' }]);
  });

  it('date-only filter joins deliverySlots and filters by deliverySlots.date, not createdAt', async () => {
    const db = makeDb();
    db.queue([{ id: 'p1', tenantId: 't1', slotId: 's1', kind: 'farmer_to_operator' }]); // protocol ⋈ slots
    const svc = await build(db);
    const rows = await svc.list('t1', { date: '2026-07-13' });
    expect(rows).toEqual([{ id: 'p1', tenantId: 't1', slotId: 's1', kind: 'farmer_to_operator' }]);

    // `db.select()` always returns the shared `step` chain object — grab it
    // to inspect what the service actually joined/filtered by.
    const step = db.select.mock.results[0].value;
    expect(step.leftJoin).toHaveBeenCalledWith(deliverySlots, expect.anything());

    const wherePairs = extractEqPairs(step.where.mock.calls[0][0]);
    expect(wherePairs).toEqual(expect.arrayContaining([{ column: 'date', value: '2026-07-13' }]));
    expect(wherePairs.some((p) => p.column === 'created_at')).toBe(false);
  });
});

describe('HandoverService.getById', () => {
  it('returns the row scoped to tenant', async () => {
    const db = makeDb();
    db.queue([{ id: 'p1' }]);
    const svc = await build(db);
    const row = await svc.getById('t1', 'p1');
    expect(row).toEqual({ id: 'p1' });
  });

  it('404s when the row is missing', async () => {
    const db = makeDb();
    db.queue([]);
    const svc = await build(db);
    await expect(svc.getById('t1', 'missing')).rejects.toThrow(/намерен/);
  });
});
