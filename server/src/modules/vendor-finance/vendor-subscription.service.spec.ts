import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { VendorSubscriptionService } from './vendor-subscription.service';
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

async function build(db: any): Promise<VendorSubscriptionService> {
  const mod: TestingModule = await Test.createTestingModule({
    providers: [VendorSubscriptionService, { provide: DB_TOKEN, useValue: db }],
  }).compile();
  return mod.get(VendorSubscriptionService);
}

const TENANT = 't1';

describe('generateForPeriod', () => {
  it('409s while subscriptionEnabled is off (dormant guard)', async () => {
    const db = makeDb();
    db.queue([{ settings: {} }]);
    await expect((await build(db)).generateForPeriod(TENANT, '2026-07')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('rejects a malformed period', async () => {
    const db = makeDb();
    await expect((await build(db)).generateForPeriod(TENANT, '2026-13')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('creates due rows with override > default fee, skips fee 0', async () => {
    const db = makeDb();
    db.queue([{ settings: { vendorFinance: { subscriptionEnabled: true, defaultSubscriptionFeeStotinki: 1200 } } }]);
    db.queue([
      { id: 'f1', subscriptionFeeStotinki: null },  // default 1200
      { id: 'f2', subscriptionFeeStotinki: 500 },   // override
      { id: 'f3', subscriptionFeeStotinki: 0 },     // skipped
    ]);
    db.queue([{ id: 'c1' }, { id: 'c2' }]); // insert returning
    const res = await (await build(db)).generateForPeriod(TENANT, '2026-07');
    expect(db.calls.values[0]).toEqual([
      expect.objectContaining({ farmerId: 'f1', period: '2026-07', feeStotinki: 1200 }),
      expect.objectContaining({ farmerId: 'f2', period: '2026-07', feeStotinki: 500 }),
    ]);
    expect(res).toEqual({ created: 2, skipped: 1 });
  });
});

describe('setStatus', () => {
  it('marks paid with paidAt, 404s on missing row', async () => {
    const db = makeDb();
    db.queue([{ id: 'c1', farmerId: 'f1', period: '2026-07', feeStotinki: 1200, status: 'paid', paidAt: new Date(), note: null }]);
    const row = await (await build(db)).setStatus('c1', TENANT, 'paid');
    expect(row.status).toBe('paid');
    expect(db.calls.set[0]).toMatchObject({ status: 'paid' });
    expect((db.calls.set[0] as any).paidAt).toBeInstanceOf(Date);

    const db2 = makeDb();
    db2.queue([]);
    await expect((await build(db2)).setStatus('nope', TENANT, 'waived')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('list', () => {
  it('joins farmer names', async () => {
    const db = makeDb();
    db.queue([
      { id: 'c1', farmerId: 'f1', period: '2026-07', feeStotinki: 1200, status: 'due', paidAt: null, note: null },
    ]);
    db.queue([{ id: 'f1', name: 'Васил' }]);
    const rows = await (await build(db)).list(TENANT, '2026-07');
    expect(rows[0].farmerName).toBe('Васил');
  });
});
