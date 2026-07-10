import { Test, TestingModule } from '@nestjs/testing';
import { CommissionService } from './commission.service';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';

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

async function build(db: any): Promise<CommissionService> {
  const mod: TestingModule = await Test.createTestingModule({
    providers: [CommissionService, { provide: DB_TOKEN, useValue: db }],
  }).compile();
  return mod.get(CommissionService);
}

const ORDER = 'o1';
const TENANT = 't1';

describe('CommissionService.accrueForOrder', () => {
  it('writes one entry per farmer with snapshot rate and rounding', async () => {
    const db = makeDb();
    db.queue([{ id: ORDER, status: 'confirmed', codOutcome: 'received' }]); // order
    db.queue([
      { farmerId: 'f1', quantity: 2, priceStotinki: 305 }, // f1 gross 610
      { farmerId: 'f1', quantity: 1, priceStotinki: 100 }, // f1 gross 710
      { farmerId: 'f2', quantity: 3, priceStotinki: 333 }, // f2 gross 999
      { farmerId: null, quantity: 5, priceStotinki: 100 }, // tenant's own → skipped
    ]); // items
    db.queue([{ settings: { vendorFinance: { commissionEnabled: true, defaultCommissionRateBps: 500 } } }]); // tenant
    db.queue([{ id: 'f1', commissionRateBps: 1000 }, { id: 'f2', commissionRateBps: null }]); // overrides
    db.queue(undefined); // insert
    db.queue(undefined); // revive update

    await (await build(db)).accrueForOrder(ORDER, TENANT);

    expect(db.calls.values).toHaveLength(1);
    const rows = db.calls.values[0] as any[];
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ farmerId: 'f1', grossStotinki: 710, rateBps: 1000, commissionStotinki: 71 }),
        // 999 * 500 / 10000 = 49.95 → 50
        expect.objectContaining({ farmerId: 'f2', grossStotinki: 999, rateBps: 500, commissionStotinki: 50 }),
      ]),
    );
    expect(rows).toHaveLength(2);
    // revive of voided entries fired
    expect(db.calls.set).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'accrued' })]));
  });

  it('records rate 0 while commission is disabled (dormant)', async () => {
    const db = makeDb();
    db.queue([{ id: ORDER, status: 'confirmed', codOutcome: null }]);
    db.queue([{ farmerId: 'f1', quantity: 1, priceStotinki: 1000 }]);
    db.queue([{ settings: {} }]); // no vendorFinance at all
    db.queue([{ id: 'f1', commissionRateBps: 700 }]); // override present but feature OFF
    db.queue(undefined);
    db.queue(undefined);

    await (await build(db)).accrueForOrder(ORDER, TENANT);

    expect(db.calls.values[0]).toEqual([
      expect.objectContaining({ farmerId: 'f1', grossStotinki: 1000, rateBps: 0, commissionStotinki: 0 }),
    ]);
  });

  it.each([
    ['cancelled order', { id: ORDER, status: 'cancelled', codOutcome: null }],
    ['refused COD', { id: ORDER, status: 'confirmed', codOutcome: 'refused' }],
  ])('never accrues on a dead order (%s)', async (_name, order) => {
    const db = makeDb();
    db.queue([order]);
    await (await build(db)).accrueForOrder(ORDER, TENANT);
    expect(db.calls.values).toHaveLength(0);
  });

  it('does nothing when the order has no vendor items', async () => {
    const db = makeDb();
    db.queue([{ id: ORDER, status: 'confirmed', codOutcome: null }]);
    db.queue([{ farmerId: null, quantity: 1, priceStotinki: 500 }]);
    await (await build(db)).accrueForOrder(ORDER, TENANT);
    expect(db.calls.values).toHaveLength(0);
  });

  it('swallows DB errors (fire-and-forget seam safety)', async () => {
    const db = makeDb();
    db.queue(new Error('boom'));
    await expect((await build(db)).accrueForOrder(ORDER, TENANT)).resolves.toBeUndefined();
  });
});

describe('CommissionService.voidForOrder', () => {
  it('voids accrued entries only', async () => {
    const db = makeDb();
    db.queue(undefined); // update
    await (await build(db)).voidForOrder(ORDER, TENANT);
    expect(db.calls.set).toEqual([{ status: 'voided' }]);
  });
});

describe('CommissionService.summary', () => {
  it('aggregates per farmer, names, totals', async () => {
    const db = makeDb();
    db.queue([
      { farmerId: 'f1', grossStotinki: 700, commissionStotinki: 70, status: 'accrued' },
      { farmerId: 'f1', grossStotinki: 300, commissionStotinki: 30, status: 'settled' },
      { farmerId: 'f2', grossStotinki: 999, commissionStotinki: 50, status: 'accrued' },
    ]); // entries
    db.queue([{ id: 'f1', name: 'Васил' }, { id: 'f2', name: 'Мариана' }]); // names
    db.queue([{ settings: { vendorFinance: { commissionEnabled: false } } }]); // tenant

    const s = await (await build(db)).summary(TENANT);
    expect(s.commissionEnabled).toBe(false);
    expect(s.totalGrossStotinki).toBe(1999);
    expect(s.totalCommissionStotinki).toBe(150);
    const f1 = s.farmers.find((f) => f.farmerId === 'f1')!;
    expect(f1).toMatchObject({
      farmerName: 'Васил', orderCount: 2, grossStotinki: 1000,
      commissionStotinki: 100, settledCommissionStotinki: 30,
    });
  });
});
