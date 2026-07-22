import { and, eq, isNull } from 'drizzle-orm';
import { consolidatedProtocols } from '@fermeribg/db';
import { ConsolidatedProtocolService } from './consolidated-protocol.service';

const CHAIN_METHODS = [
  'select', 'from', 'where', 'innerJoin', 'leftJoin', 'limit', 'orderBy',
  'update', 'insert', 'returning', 'delete',
] as const;

function makeDb() {
  const queue: unknown[] = [];
  const calls: { values: unknown[]; where: unknown[] } = { values: [], where: [] };
  const step: any = {};
  for (const m of CHAIN_METHODS) step[m] = jest.fn(() => step);
  step.values = jest.fn((v: unknown) => { calls.values.push(v); return step; });
  step.where = jest.fn((c: unknown) => { calls.where.push(c); return step; });
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
