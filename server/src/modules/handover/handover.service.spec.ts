import { Test, TestingModule } from '@nestjs/testing';
import { deliverySlots } from '@fermeribg/db';
import { HandoverService } from './handover.service';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { encryptSignature, decryptSignature, looksEncrypted } from '../../common/crypto/signature-crypto';

const FARMER_PNG = 'data:image/png;base64,FARMERSIGNATUREDATA==';
const OP_PNG = 'data:image/png;base64,OPERATORSIGNATUREDATA==';

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
  // createSigned/createBatch wrap protocol-number assignment + insert in
  // db.transaction(...) with an advisory lock (see orders.service.ts's
  // order-number pattern). `execute()` (the lock acquisition) doesn't consume
  // the FIFO queue — only select()/insert() do — and transaction() runs the
  // callback against this same `db` mock, so it's transparent to every
  // existing queued-value test.
  db.execute = jest.fn(() => Promise.resolve(undefined));
  db.transaction = jest.fn((fn: (tx: unknown) => Promise<unknown>) => fn(db));
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
    expect(draft.orderNumbers).toEqual([5, 7]); // distinct, sorted, across the farmer's orders in the slot
  });

  it('falls back to the plain farmer/operator name when legal identity is unset', async () => {
    const db = makeDb();
    db.queue([{ legal: null, name: 'Фермерски пазари' }]);        // tenant: no legal, has display name
    db.queue([{ id: 'f1', legal: null, name: 'Васил Цанчев' }]);  // farmer: no legal, has name
    db.queue([
      { productName: 'Домати', variantLabel: null, quantity: 2, unit: 'кг', priceStotinki: 300 },
    ]);
    const svc = await build(db);
    const draft = await svc.buildDraft('t1', { kind: 'farmer_to_operator', farmerId: 'f1', slotId: 's1' });
    expect(draft.from).toEqual({ name: 'Васил Цанчев' });
    expect(draft.to).toEqual({ name: 'Фермерски пазари' });
  });

  it('throws 400 only when there is no name at all (legal AND display name blank)', async () => {
    const db = makeDb();
    db.queue([{ legal: { name: 'ЕТ Оператор' } }]);   // tenant ok
    db.queue([{ id: 'f1', legal: null, name: null }]); // farmer: no legal, no name
    const svc = await build(db);
    await expect(svc.buildDraft('t1', { kind: 'farmer_to_operator', farmerId: 'f1', slotId: 's1' }))
      .rejects.toThrow(/фермер/);
  });

  it('attaches phone/email (party enrichment) + saved, decrypted signatures for the farmer and operator', async () => {
    const OLD_KEY = process.env.ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY = 'k';
    try {
      const db = makeDb();
      db.queue([{
        legal: { name: 'ЕТ Оператор' },
        contact: { phone: '0899000000', email: 'op@example.bg' },
        operatorSignaturePng: encryptSignature(OP_PNG, 'k'),
      }]); // tenant settings.legal + settings.contact + operator signature
      db.queue([{
        id: 'f1',
        legal: { name: 'ЕТ Васил' },
        phone: '0888111222',
        email: 'vasil@example.bg',
        signaturePng: encryptSignature(FARMER_PNG, 'k'),
      }]); // farmer + its saved signature
      db.queue([{ productName: 'Домати', variantLabel: null, quantity: 2, unit: 'кг', priceStotinki: 300, orderNumber: 5 }]);
      const svc = await build(db);
      const draft = await svc.buildDraft('t1', { kind: 'farmer_to_operator', farmerId: 'f1', slotId: 's1' });
      expect(draft.from).toEqual({ name: 'ЕТ Васил', phone: '0888111222', email: 'vasil@example.bg' });
      expect(draft.to).toEqual({ name: 'ЕТ Оператор', phone: '0899000000', email: 'op@example.bg' });
      expect(draft.savedFromSignature).toBe(FARMER_PNG);
      expect(draft.savedToSignature).toBe(OP_PNG);
    } finally {
      if (OLD_KEY === undefined) delete process.env.ENCRYPTION_KEY;
      else process.env.ENCRYPTION_KEY = OLD_KEY;
    }
  });
});

describe('HandoverService.buildDraft operator_to_customer', () => {
  it('uses the order items + customer identity; total is the COD amount', async () => {
    const db = makeDb();
    db.queue([{ legal: { name: 'ЕТ Оператор' } }]); // tenant settings.legal
    db.queue([{ id: 'o9', customerName: 'Иван Петров', customerPhone: '0888', deliveryAddress: 'ул. Роза 1', totalStotinki: 720, orderNumber: 9 }]); // order
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
    expect(draft.orderNumbers).toEqual([9]); // the single order's number
  });

  it('falls back to the operator plain name when operator legal is unset', async () => {
    const db = makeDb();
    db.queue([{ legal: null, name: 'Фермерски пазари' }]); // tenant: no legal, has display name
    db.queue([{ id: 'o9', customerName: 'Иван Петров', customerPhone: '0888', deliveryAddress: 'ул. Роза 1', totalStotinki: 720 }]);
    db.queue([{ productName: 'Домати', variantLabel: null, quantity: 2, priceStotinki: 300, unit: 'кг', name: 'Домати' }]);
    const svc = await build(db);
    const draft = await svc.buildDraft('t1', { kind: 'operator_to_customer', orderId: 'o9' });
    expect(draft.from).toEqual({ name: 'Фермерски пазари' });
  });

  it('attaches the operator\'s phone/email + saved signature; the customer leg never has a saved "to" signature', async () => {
    const OLD_KEY = process.env.ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY = 'k';
    try {
      const db = makeDb();
      db.queue([{
        legal: { name: 'ЕТ Оператор' },
        contact: { phone: '0899000000', email: 'op@example.bg' },
        operatorSignaturePng: encryptSignature(OP_PNG, 'k'),
      }]);
      db.queue([{ id: 'o9', customerName: 'Иван Петров', customerPhone: '0888', deliveryAddress: 'ул. Роза 1', totalStotinki: 720, orderNumber: 9 }]);
      db.queue([{ productName: 'Домати', variantLabel: null, quantity: 2, priceStotinki: 300, unit: 'кг', name: 'Домати' }]);
      const svc = await build(db);
      const draft = await svc.buildDraft('t1', { kind: 'operator_to_customer', orderId: 'o9' });
      expect(draft.from).toEqual({ name: 'ЕТ Оператор', phone: '0899000000', email: 'op@example.bg' });
      expect(draft.savedFromSignature).toBe(OP_PNG);
      expect(draft.savedToSignature).toBeNull();
    } finally {
      if (OLD_KEY === undefined) delete process.env.ENCRYPTION_KEY;
      else process.env.ENCRYPTION_KEY = OLD_KEY;
    }
  });
});

describe('HandoverService.createSigned', () => {
  // Signature encryption needs ENCRYPTION_KEY. Set for every test in this describe
  // (mirrors farmers.signature.spec.ts / tenants.signature.spec.ts); individual tests
  // that need "no key" delete it locally — the next beforeEach puts it back.
  const OLD_KEY = process.env.ENCRYPTION_KEY;
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = 'test-key';
  });
  afterAll(() => {
    if (OLD_KEY === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = OLD_KEY;
  });

  it('assigns the next per-tenant protocol_number and stores ENCRYPTED digital signatures', async () => {
    const db = makeDb();
    // buildDraft re-derivation (farmer leg):
    db.queue([{ legal: { name: 'ЕТ Оператор' } }]);
    db.queue([{ id: 'f1', legal: { name: 'ЕТ Васил' } }]);
    db.queue([{ productName: 'Домати', variantLabel: null, quantity: 5, unit: 'кг', priceStotinki: 300, orderNumber: 5 }]);
    db.queue([]);                                  // outer dup-check (fast-path): none found
    db.queue([]);                                  // in-tx dup re-check under the lock: none found
    db.queue([{ max: 40 }]);                       // current max protocol_number
    db.queue([{ id: 'p1', protocolNumber: 41 }]);  // insert ... returning
    const svc = await build(db);
    const res = await svc.createSigned('t1', {
      kind: 'farmer_to_operator', farmerId: 'f1', slotId: 's1',
      items: [{ productName: 'Домати', quantity: 5, priceStotinki: 300 }],
      fromSignaturePng: 'data:image/png;base64,AAA', toSignaturePng: 'data:image/png;base64,BBB',
      meta: { device: 'ipad', userAgent: 'Mozilla/5.0' },
    } as any);
    expect(res.protocolNumber).toBe(41);
    const inserted = db.calls.values[0] as any;
    expect(inserted.status).toBe('signed');
    expect(inserted.signMode).toBe('digital');
    expect(inserted.protocolNumber).toBe(41);
    expect(inserted.fromSnapshot).toEqual({ name: 'ЕТ Васил' });      // frozen, not client-supplied
    expect(inserted.totalStotinki).toBe(1500);                        // re-derived, not trusted from client
    expect(inserted.meta).toEqual({ device: 'ipad', userAgent: 'Mozilla/5.0', orderNumbers: [5] }); // e-sig evidence + order refs, not dropped
    // The DTO-supplied signatures must be ciphertext at rest, and decrypt back to
    // exactly what was submitted — never stored in plaintext.
    expect(looksEncrypted(inserted.fromSignaturePng)).toBe(true);
    expect(looksEncrypted(inserted.toSignaturePng)).toBe(true);
    expect(decryptSignature(inserted.fromSignaturePng, 'test-key')).toBe('data:image/png;base64,AAA');
    expect(decryptSignature(inserted.toSignaturePng, 'test-key')).toBe('data:image/png;base64,BBB');
  });

  it('auto-fills saved farmer + operator signatures when the DTO omits them', async () => {
    const db = makeDb();
    db.queue([{ legal: { name: 'ЕТ Оператор' }, operatorSignaturePng: encryptSignature(OP_PNG, 'test-key') }]);
    db.queue([{ id: 'f1', legal: { name: 'ЕТ Васил' }, signaturePng: encryptSignature(FARMER_PNG, 'test-key') }]);
    db.queue([{ productName: 'Домати', variantLabel: null, quantity: 5, unit: 'кг', priceStotinki: 300, orderNumber: 5 }]);
    db.queue([]);                                  // outer dup-check (fast-path): none found
    db.queue([]);                                  // in-tx dup re-check under the lock: none found
    db.queue([{ max: 40 }]);                       // current max protocol_number
    db.queue([{ id: 'p1', protocolNumber: 41 }]);  // insert ... returning
    const svc = await build(db);
    const res = await svc.createSigned('t1', {
      kind: 'farmer_to_operator', farmerId: 'f1', slotId: 's1',
      items: [{ productName: 'Домати', quantity: 5, priceStotinki: 300 }],
    } as any); // no fromSignaturePng/toSignaturePng in the DTO
    expect(res.protocolNumber).toBe(41);
    const inserted = db.calls.values[0] as any;
    expect(inserted.signMode).toBe('digital');
    expect(inserted.fromSignaturePng).not.toBeNull();
    expect(inserted.toSignaturePng).not.toBeNull();
    expect(looksEncrypted(inserted.fromSignaturePng)).toBe(true);
    expect(looksEncrypted(inserted.toSignaturePng)).toBe(true);
    expect(decryptSignature(inserted.fromSignaturePng, 'test-key')).toBe(FARMER_PNG);
    expect(decryptSignature(inserted.toSignaturePng, 'test-key')).toBe(OP_PNG);
  });

  // Regression: `dto.toSignaturePng ?? draft.savedToSignature ?? null` used to
  // coalesce BOTH `undefined` (omitted) and an explicit `null` (party declined —
  // «Получено без подпис») onto the saved signature. That silently put a signature
  // on a legal document the party explicitly refused to give. Absent key = auto-fill
  // (see the previous test); explicit `null` must be honoured and stored as no
  // signature — this test must fail if someone reverts to `??`.
  it('honours an explicit null "to" signature — does NOT auto-fill the saved one, and reports signMode "paper"', async () => {
    const db = makeDb();
    db.queue([{ legal: { name: 'ЕТ Оператор' }, operatorSignaturePng: encryptSignature(OP_PNG, 'test-key') }]);
    db.queue([{ id: 'f1', legal: { name: 'ЕТ Васил' } }]);
    db.queue([{ productName: 'Домати', variantLabel: null, quantity: 5, unit: 'кг', priceStotinki: 300, orderNumber: 5 }]);
    db.queue([]);                                  // outer dup-check (fast-path): none found
    db.queue([]);                                  // in-tx dup re-check under the lock: none found
    db.queue([{ max: 40 }]);                       // current max protocol_number
    db.queue([{ id: 'p1', protocolNumber: 41 }]);  // insert ... returning
    const svc = await build(db);
    const res = await svc.createSigned('t1', {
      kind: 'farmer_to_operator', farmerId: 'f1', slotId: 's1',
      items: [{ productName: 'Домати', quantity: 5, priceStotinki: 300 }],
      fromSignaturePng: 'data:image/png;base64,AAA',
      toSignaturePng: null, // operator explicitly ticked «Получено без подпис»
    } as any);
    expect(res.protocolNumber).toBe(41);
    const inserted = db.calls.values[0] as any;
    // The operator DOES have a saved signature on file (queued above) — it must not
    // be substituted for the explicit decline.
    expect(inserted.toSignaturePng).toBeNull();
    expect(looksEncrypted(inserted.fromSignaturePng)).toBe(true);
    expect(decryptSignature(inserted.fromSignaturePng, 'test-key')).toBe('data:image/png;base64,AAA');
    // Only one of the two required parties actually signed — must not be reported as
    // fully digital, which would misrepresent an explicitly-declined signature.
    expect(inserted.signMode).toBe('paper');
  });

  it('fails with a clear error (not a raw crash) when ENCRYPTION_KEY is missing and a fresh signature must be stored', async () => {
    delete process.env.ENCRYPTION_KEY; // simulate a misconfigured server
    const db = makeDb();
    db.queue([{ legal: { name: 'ЕТ Оператор' } }]);
    db.queue([{ id: 'f1', legal: { name: 'ЕТ Васил' } }]);
    db.queue([{ productName: 'Домати', variantLabel: null, quantity: 1, unit: 'кг', priceStotinki: 300 }]);
    const svc = await build(db);
    await expect(svc.createSigned('t1', {
      kind: 'farmer_to_operator', farmerId: 'f1', slotId: 's1',
      items: [{ productName: 'Домати', quantity: 1, priceStotinki: 300 }],
      fromSignaturePng: 'data:image/png;base64,AAA',
    } as any)).rejects.toThrow(/ключ за криптиране/);
    expect(db.calls.values).toEqual([]); // never inserted — fails before the transaction
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

  // Race guard: a duplicate that lands AFTER the pre-lock fast-path check but before
  // this call's insert must be caught by the IN-TX re-check under the advisory lock —
  // otherwise two signed protocols for one target are created with distinct numbers.
  it('the in-tx re-check rejects a target that appears after the fast-path check', async () => {
    const db = makeDb();
    db.queue([{ legal: { name: 'ЕТ Оператор' } }]);        // buildDraft: tenant
    db.queue([{ id: 'f1', legal: { name: 'ЕТ Васил' } }]); // buildDraft: farmer
    db.queue([{ productName: 'Домати', variantLabel: null, quantity: 1, unit: 'кг', priceStotinki: 300 }]); // buildDraft: items
    db.queue([]);                                          // outer fast-path check: none (race window opens)
    db.queue([{ id: 'raced' }]);                           // IN-TX re-check under lock: a concurrent sign committed
    const svc = await build(db);
    await expect(svc.createSigned('t1', {
      kind: 'farmer_to_operator', farmerId: 'f1', slotId: 's1',
      items: [{ productName: 'Домати', quantity: 1, priceStotinki: 300 }],
    } as any)).rejects.toThrow(/вече/);
    expect(db.calls.values).toEqual([]); // blocked before any insert
  });
});

describe('HandoverService.createBatch', () => {
  it('creates one row per uncovered target and skips already-covered ones', async () => {
    const db = makeDb();
    db.queue([{ farmerId: 'f1', slotId: 's1' }]);          // distinct farmer pickups for the slot
    db.queue([{ id: 'o1', slotId: 's1' }]);                // customer orders for the slot
    // prefetchDraftContext — one bulk read each, before the per-target loop:
    db.queue([{ legal: { name: 'ЕТ Оператор' } }]);         // prefetch: tenant legal
    db.queue([{ id: 'f1', legal: { name: 'ЕТ Васил' }, name: 'Васил' }]); // prefetch: farmers by id
    db.queue([                                              // prefetch: farmer items ⋈ products ⋈ orders
      { farmerId: 'f1', slotId: 's1', productName: 'Домати', variantLabel: null, quantity: 2, unit: 'кг', priceStotinki: 300, orderNumber: null },
    ]);
    db.queue([{ id: 'o1', customerName: 'Иван', customerPhone: '0888', deliveryAddress: 'ул. 1', totalStotinki: 720, orderNumber: 1 }]); // prefetch: customer orders by id
    db.queue([{ orderId: 'o1', productName: 'Мед', variantLabel: null, quantity: 1, priceStotinki: 720, unit: 'бр', name: 'Мед' }]); // prefetch: customer items
    db.queue([]);                                          // loop: farmer target f1/s1 existing? none
    db.queue([]);                                          // in-tx dup re-check under the lock: none
    db.queue([{ max: 5 }]);                                 // tx: current max protocol_number (per-target)
    db.queue([{ id: 'p-new' }]);                            // tx: insert ... returning
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

  it('skips a target whose legal data is missing instead of aborting the whole batch', async () => {
    const db = makeDb();
    db.queue([{ farmerId: 'f1', slotId: 's1' }]);          // distinct farmer pickups for the slot
    db.queue([{ id: 'o1', slotId: 's1' }]);                // customer orders for the slot
    // prefetchDraftContext:
    db.queue([{ legal: { name: 'ЕТ Оператор' } }]);         // prefetch: tenant legal
    db.queue([{ id: 'f1', legal: null, name: null }]);      // prefetch: farmer — no legal AND no name → buildDraft throws in-loop
    db.queue([]);                                          // prefetch: farmer items (none for f1)
    db.queue([{ id: 'o1', customerName: 'Иван', customerPhone: '0888', deliveryAddress: 'ул. Роза 1', totalStotinki: 720, orderNumber: 1 }]); // prefetch: customer orders
    db.queue([                                              // prefetch: customer items
      { orderId: 'o1', productName: 'Домати', variantLabel: null, quantity: 2, priceStotinki: 300, unit: 'кг', name: 'Домати' },
    ]);
    db.queue([]);                                          // loop: farmer f1 existing? none → buildDraft(ctx) throws (no фермер name) → skipped
    db.queue([]);                                          // loop: customer o1 existing? none
    db.queue([]);                                          // in-tx dup re-check under the lock: none
    db.queue([{ max: 5 }]);                                 // tx: current max protocol_number (customer target)
    db.queue([{ id: 'p-customer' }]);                       // tx: insert ... returning

    const svc = await build(db);
    const res = await svc.createBatch('t1', { slotId: 's1' } as any);

    expect(res.ids).toEqual(['p-customer']);
    expect(res.skipped).toEqual([
      { kind: 'farmer_to_operator', farmerId: 'f1', slotId: 's1', reason: expect.stringMatching(/фермер/) },
    ]);
  });

  it('is idempotent — a second run with all targets already covered creates zero rows', async () => {
    const db = makeDb();
    db.queue([{ farmerId: 'f1', slotId: 's1' }]);
    db.queue([{ id: 'o1', slotId: 's1' }]);
    // prefetchDraftContext still runs once (bounded) even when every target is covered:
    db.queue([{ legal: { name: 'ЕТ Оператор' } }]);       // prefetch tenant
    db.queue([{ id: 'f1', legal: null, name: 'Васил' }]);  // prefetch farmers
    db.queue([]);                                         // prefetch farmerItems
    db.queue([{ id: 'o1', customerName: 'Иван', customerPhone: null, deliveryAddress: null, totalStotinki: 100, orderNumber: 1 }]); // prefetch customerOrders
    db.queue([]);                                         // prefetch customerItems
    db.queue([{ id: 'p-new' }]);   // farmer target already covered
    db.queue([{ id: 'existing' }]); // customer target already covered

    const svc = await build(db);
    const res = await svc.createBatch('t1', { slotId: 's1' } as any);

    expect(res.ids).toEqual([]);
    expect(db.calls.values).toEqual([]);
  });
});

describe('HandoverService.listForDay', () => {
  it('merges live-computed targets (virtual, id=null) with already-persisted rows', async () => {
    const db = makeDb();
    db.queue([{ farmerId: 'f1', slotId: 's1' }]);                       // farmer pickups for the slot
    db.queue([{ id: 'o1', slotId: 's1', customerName: 'Иван Петров' }]); // customer orders for the slot
    db.queue([                                                          // persisted rows (this.list)
      {
        id: 'p1',
        kind: 'operator_to_customer',
        farmerId: null,
        orderId: 'o1',
        slotId: 's1',
        status: 'signed',
        protocolNumber: 5,
        fromSnapshot: { name: 'Оп' },
        toSnapshot: { name: 'Иван Петров' },
      },
    ]);
    db.queue([{ legal: null, name: 'Фермерски пазари' }]);              // tenant name+legal
    db.queue([{ id: 'f1', legal: null, name: 'Васил Цанчев' }]);        // farmers by id

    const svc = await build(db);
    const rows = await svc.listForDay('t1', { slotId: 's1' });

    // f1 has no persisted row → virtual (id null); o1 is persisted → real row.
    const farmer = rows.find((r) => r.farmerId === 'f1')!;
    expect(farmer.id).toBeNull();
    expect(farmer.status).toBe('draft');
    expect(farmer.fromSnapshot).toEqual({ name: 'Васил Цанчев' });
    expect(farmer.toSnapshot).toEqual({ name: 'Фермерски пазари' });

    const customer = rows.find((r) => r.orderId === 'o1')!;
    expect(customer.id).toBe('p1');
    expect(customer.status).toBe('signed');
    expect(customer.protocolNumber).toBe(5);
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

describe('HandoverService.createBatch kind filter', () => {
  it('creates only the customer leg when kind=operator_to_customer', async () => {
    const db = makeDb();
    db.queue([{ farmerId: 'f1', slotId: 's1' }]); // farmer pickups (ignored by kind filter)
    db.queue([{ id: 'o1', slotId: 's1' }]);        // customer orders
    // prefetchDraftContext — no farmer targets (kind filter), so the farmer legal + farmer
    // items reads are skipped; only tenant + customer orders + customer items run:
    db.queue([{ legal: { name: 'ЕТ Оператор' } }]); // prefetch: tenant legal
    db.queue([{ id: 'o1', customerName: 'Иван', customerPhone: '0888', deliveryAddress: 'ул. Роза 1', totalStotinki: 720, orderNumber: 1 }]); // prefetch: customer orders
    db.queue([{ orderId: 'o1', productName: 'Домати', variantLabel: null, quantity: 2, priceStotinki: 300, unit: 'кг', name: 'Домати' }]); // prefetch: customer items
    db.queue([]);                                   // loop: customer o1 existing? none
    db.queue([]);                                   // in-tx dup re-check under the lock: none
    db.queue([{ max: 2 }]);                         // tx max
    db.queue([{ id: 'p-cust' }]);                   // insert returning

    const svc = await build(db);
    const res = await svc.createBatch('t1', { slotId: 's1', kind: 'operator_to_customer' } as any);

    expect(res.ids).toEqual(['p-cust']);
    expect((db.calls.values[0] as any).kind).toBe('operator_to_customer');
  });
});

describe('HandoverService.signAllForDay', () => {
  it('paper-signs every target and returns the newly-signed count', async () => {
    const db = makeDb();
    db.queue([{ farmerId: 'f1', slotId: 's1' }]); // farmer pickups
    db.queue([]);                                  // customer orders: none
    // prefetchDraftContext (once, before the sign loop) — no customer orders, so only
    // tenant + farmer legal + farmer items run:
    db.queue([{ legal: null, name: 'Оп' }]);        // prefetch: tenant legal
    db.queue([{ id: 'f1', legal: null, name: 'Васил' }]); // prefetch: farmers by id
    db.queue([{ farmerId: 'f1', slotId: 's1', productName: 'Домати', variantLabel: null, quantity: 2, unit: 'кг', priceStotinki: 300, orderNumber: null }]); // prefetch: farmer items
    // signPaperTarget(farmer f1/s1): buildDraft assembles from ctx (no query)
    db.queue([]);                                  // existing? none
    db.queue([]);                                   // in-tx dup re-check under the lock: none
    db.queue([{ max: 0 }]);                          // tx max
    db.queue([{ id: 'p1' }]);                       // insert returning

    const svc = await build(db);
    const res = await svc.signAllForDay('t1', { slotId: 's1' } as any);
    expect(res.signed).toBe(1);
    expect((db.calls.values[0] as any).status).toBe('signed');
    expect((db.calls.values[0] as any).signMode).toBe('paper');
  });
});

describe('HandoverService.ensureDraftTarget', () => {
  it('creates a numbered draft for a not-yet-persisted target', async () => {
    const db = makeDb();
    db.queue([]);                                  // existing? none
    db.queue([{ legal: null, name: 'Оп' }]);        // buildDraft: tenant
    db.queue([{ id: 'f1', legal: null, name: 'Васил' }]); // buildDraft: farmer
    db.queue([{ productName: 'Домати', variantLabel: null, quantity: 2, unit: 'кг', priceStotinki: 300 }]);
    db.queue([]);                                   // in-tx dup re-check under the lock: none
    db.queue([{ max: 3 }]);                          // tx: max protocol_number
    db.queue([{ id: 'p1' }]);                       // tx: insert returning
    const svc = await build(db);
    const res = await svc.ensureDraftTarget('t1', { kind: 'farmer_to_operator', farmerId: 'f1', slotId: 's1' });
    expect(res.id).toBe('p1');
    const inserted = db.calls.values[0] as any;
    expect(inserted.status).toBe('draft');
    expect(inserted.signMode).toBe('pending');
    expect(inserted.protocolNumber).toBe(4);
  });

  it('returns the existing row id without creating a duplicate', async () => {
    const db = makeDb();
    db.queue([{ id: 'p9' }]); // existing
    const svc = await build(db);
    const res = await svc.ensureDraftTarget('t1', { kind: 'operator_to_customer', orderId: 'o1' });
    expect(res.id).toBe('p9');
    expect(db.calls.values).toEqual([]);
  });
});

describe('HandoverService.signPaperTarget', () => {
  it('creates a signed(paper) protocol for a not-yet-persisted target', async () => {
    const db = makeDb();
    db.queue([]);                                  // existing? none
    db.queue([{ legal: null, name: 'Оп' }]);        // buildDraft: tenant
    db.queue([{ id: 'f1', legal: null, name: 'Васил' }]); // buildDraft: farmer
    db.queue([{ productName: 'Домати', variantLabel: null, quantity: 2, unit: 'кг', priceStotinki: 300 }]);
    db.queue([]);                                   // in-tx dup re-check under the lock: none
    db.queue([{ max: 7 }]);                          // tx: max protocol_number
    db.queue([{ id: 'p-new' }]);                    // tx: insert returning
    const svc = await build(db);
    const res = await svc.signPaperTarget('t1', { kind: 'farmer_to_operator', farmerId: 'f1', slotId: 's1' });
    expect(res.id).toBe('p-new');
    const inserted = db.calls.values[0] as any;
    expect(inserted.status).toBe('signed');
    expect(inserted.signMode).toBe('paper');
    expect(inserted.protocolNumber).toBe(8);
    expect(inserted.signedAt).toBeInstanceOf(Date);
  });

  it('signs DIGITALLY (not paper) when both the farmer and operator already have a saved signature', async () => {
    const OLD_KEY = process.env.ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY = 'k';
    try {
      const db = makeDb();
      db.queue([]);                                  // existing? none
      db.queue([{ legal: null, name: 'Оп', operatorSignaturePng: encryptSignature(OP_PNG, 'k') }]); // buildDraft: tenant
      db.queue([{ id: 'f1', legal: null, name: 'Васил', signaturePng: encryptSignature(FARMER_PNG, 'k') }]); // buildDraft: farmer
      db.queue([{ productName: 'Домати', variantLabel: null, quantity: 2, unit: 'кг', priceStotinki: 300 }]);
      db.queue([]);                                   // in-tx dup re-check under the lock: none
      db.queue([{ max: 7 }]);                          // tx: max protocol_number
      db.queue([{ id: 'p-new' }]);                    // tx: insert returning
      const svc = await build(db);
      const res = await svc.signPaperTarget('t1', { kind: 'farmer_to_operator', farmerId: 'f1', slotId: 's1' });
      expect(res.id).toBe('p-new');
      const inserted = db.calls.values[0] as any;
      expect(inserted.status).toBe('signed');
      expect(inserted.signMode).toBe('digital');
      expect(looksEncrypted(inserted.fromSignaturePng)).toBe(true);
      expect(looksEncrypted(inserted.toSignaturePng)).toBe(true);
      expect(decryptSignature(inserted.fromSignaturePng, 'k')).toBe(FARMER_PNG);
      expect(decryptSignature(inserted.toSignaturePng, 'k')).toBe(OP_PNG);
    } finally {
      if (OLD_KEY === undefined) delete process.env.ENCRYPTION_KEY;
      else process.env.ENCRYPTION_KEY = OLD_KEY;
    }
  });

  it('marks an existing draft signed(paper) instead of creating a duplicate', async () => {
    const db = makeDb();
    db.queue([{ id: 'p1', status: 'draft' }]); // existing draft
    db.queue([{ id: 'p1' }]);                  // update returning
    const svc = await build(db);
    const res = await svc.signPaperTarget('t1', { kind: 'operator_to_customer', orderId: 'o1' });
    expect(res.id).toBe('p1');
    const set = db.calls.set[0] as any;
    expect(set.status).toBe('signed');
    expect(set.signMode).toBe('paper');
  });

  it('rejects when the target is already signed', async () => {
    const db = makeDb();
    db.queue([{ id: 'p1', status: 'signed' }]);
    const svc = await build(db);
    await expect(svc.signPaperTarget('t1', { kind: 'operator_to_customer', orderId: 'o1' })).rejects.toThrow(/подписан/);
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
  it('returns the row scoped to tenant, with null signatures when none were ever stored', async () => {
    const db = makeDb();
    db.queue([{ id: 'p1' }]);
    const svc = await build(db);
    const row = await svc.getById('t1', 'p1');
    expect(row).toEqual({ id: 'p1', fromSignaturePng: null, toSignaturePng: null });
  });

  it('decrypts the stored signatures so the PDF renderer gets real PNGs, not ciphertext', async () => {
    const OLD_KEY = process.env.ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY = 'k';
    try {
      const db = makeDb();
      db.queue([{
        id: 'p1',
        fromSignaturePng: encryptSignature(FARMER_PNG, 'k'),
        toSignaturePng: encryptSignature(OP_PNG, 'k'),
      }]);
      const svc = await build(db);
      const row = await svc.getById('t1', 'p1');
      expect(row.fromSignaturePng).toBe(FARMER_PNG);
      expect(row.toSignaturePng).toBe(OP_PNG);
    } finally {
      if (OLD_KEY === undefined) delete process.env.ENCRYPTION_KEY;
      else process.env.ENCRYPTION_KEY = OLD_KEY;
    }
  });

  it('404s when the row is missing', async () => {
    const db = makeDb();
    db.queue([]);
    const svc = await build(db);
    await expect(svc.getById('t1', 'missing')).rejects.toThrow(/намерен/);
  });
});

/** A row shape complete enough for `renderProtocolPdf` (mirrors handover-pdf.spec.ts's ROW). */
const PDF_ROW = {
  id: 'p1', kind: 'farmer_to_operator', protocolNumber: 41,
  signedAt: new Date('2026-07-13T09:00:00Z'), createdAt: new Date('2026-07-13T08:00:00Z'),
  fromSnapshot: { name: 'ЕТ Васил Петров', eik: '203912345' },
  toSnapshot: { name: 'ЕТ Оператор', eik: '111222333' },
  items: [{ productName: 'Домати', quantity: 5, unit: 'кг', priceStotinki: 300 }],
  totalStotinki: 1500, fromSignaturePng: null, toSignaturePng: null, signMode: 'pending',
};

describe('HandoverService.renderPdf', () => {
  it('loads the row via getById (tenant-scoped) and renders it to a PDF buffer', async () => {
    const db = makeDb();
    db.queue([PDF_ROW]); // getById
    const svc = await build(db);
    const buf = await svc.renderPdf('t1', 'p1');
    expect(buf.length).toBeGreaterThan(1000);
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('404s when the row is missing', async () => {
    const db = makeDb();
    db.queue([]); // getById: not found
    const svc = await build(db);
    await expect(svc.renderPdf('t1', 'missing')).rejects.toThrow(/намерен/);
  });
});

describe('HandoverService.listForCheck', () => {
  const OLD_KEY = process.env.ENCRYPTION_KEY;
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = 'test-key';
  });
  afterAll(() => {
    if (OLD_KEY === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = OLD_KEY;
  });

  it('returns only signed rows for the date with signatures decrypted, excludes drafts, and joins deliverySlots (not createdAt)', async () => {
    const db = makeDb();
    // Captured up front so the "differs from what's stored" assertion below compares
    // against the EXACT ciphertext handed to the service — AES-GCM uses a random IV,
    // so a freshly re-encrypted value would differ trivially and prove nothing.
    const storedFrom = encryptSignature(FARMER_PNG, 'test-key');
    const storedTo = encryptSignature(OP_PNG, 'test-key');
    db.queue([
      {
        id: 'p1', kind: 'farmer_to_operator', status: 'signed', protocolNumber: 5,
        signedAt: new Date('2026-07-13T09:00:00Z'),
        fromSnapshot: { name: 'ЕТ Васил' }, toSnapshot: { name: 'ЕТ Оператор' },
        items: [{ productName: 'Домати', variantLabel: null, quantity: 5, unit: 'кг', priceStotinki: 300, orderNumber: 5 }],
        fromSignaturePng: storedFrom,
        toSignaturePng: storedTo,
      },
      {
        id: 'p2', kind: 'operator_to_customer', status: 'draft', protocolNumber: null,
        signedAt: null,
        fromSnapshot: { name: 'ЕТ Оператор' }, toSnapshot: { name: 'Иван Петров' },
        items: [], fromSignaturePng: null, toSignaturePng: null,
      },
    ]); // protocol ⋈ slots (list()'s date path)
    const svc = await build(db);
    const rows = await svc.listForCheck('t1', { date: '2026-07-13' });

    expect(rows).toHaveLength(1); // the draft is excluded — not something to show a police officer
    expect(rows[0].id).toBe('p1');
    expect(rows[0].status).toBe('signed');
    // Decrypted back to the ORIGINAL plaintext PNG, and NOT equal to the exact
    // ciphertext that was stored — proves decryption actually ran, not a pass-through.
    expect(rows[0].fromSignaturePng).toBe(FARMER_PNG);
    expect(rows[0].toSignaturePng).toBe(OP_PNG);
    expect(rows[0].fromSignaturePng).not.toBe(storedFrom);
    expect(rows[0].toSignaturePng).not.toBe(storedTo);

    // handover_protocols has no date column — the date filter MUST go through the
    // deliverySlots join list() already implements, not a createdAt range.
    const step = db.select.mock.results[0].value;
    expect(step.leftJoin).toHaveBeenCalledWith(deliverySlots, expect.anything());
  });

  it('sorts by protocolNumber and shapes items to productName/variantLabel/quantity/unit only', async () => {
    const db = makeDb();
    db.queue([
      {
        id: 'p2', kind: 'farmer_to_operator', status: 'signed', protocolNumber: 9,
        signedAt: new Date('2026-07-13T09:00:00Z'),
        fromSnapshot: { name: 'A' }, toSnapshot: { name: 'B' },
        items: [{ productName: 'Мед', variantLabel: 'буркан', quantity: 2, unit: 'бр', priceStotinki: 900, orderNumber: 3 }],
        fromSignaturePng: null, toSignaturePng: null,
      },
      {
        id: 'p1', kind: 'farmer_to_operator', status: 'signed', protocolNumber: 3,
        signedAt: new Date('2026-07-13T08:00:00Z'),
        fromSnapshot: { name: 'A' }, toSnapshot: { name: 'B' },
        items: [], fromSignaturePng: null, toSignaturePng: null,
      },
    ]);
    const svc = await build(db);
    const rows = await svc.listForCheck('t1', { slotId: 's1' });

    expect(rows.map((r) => r.id)).toEqual(['p1', 'p2']); // protocolNumber 3 before 9
    expect(rows[1].items).toEqual([{ productName: 'Мед', variantLabel: 'буркан', quantity: 2, unit: 'бр' }]);
  });
});

describe('HandoverService.renderBatchPdf', () => {
  it('merges N protocol rows (via list) into one non-empty PDF buffer', async () => {
    const db = makeDb();
    db.queue([PDF_ROW, { ...PDF_ROW, id: 'p2', protocolNumber: 42 }]); // list()
    const svc = await build(db);
    const buf = await svc.renderBatchPdf('t1', { slotId: 's1' } as any);
    expect(buf.length).toBeGreaterThan(0);
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('throws a 400 in Bulgarian when there are no protocols for the slot/date', async () => {
    const db = makeDb();
    db.queue([]); // list(): no rows
    const svc = await build(db);
    await expect(svc.renderBatchPdf('t1', { slotId: 's1' } as any)).rejects.toThrow(/Няма протоколи/);
  });
});
