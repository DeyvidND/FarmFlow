import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { SlotsService, PUBLIC_SLOT_COLUMNS } from './slots.service';

describe('PUBLIC_SLOT_COLUMNS', () => {
  it('exposes customerNote and never driverNote', () => {
    expect(PUBLIC_SLOT_COLUMNS).toContain('customerNote');
    expect(PUBLIC_SLOT_COLUMNS).not.toContain('driverNote');
  });
});

/** Minimal chainable db stub matching the calls materializeRule makes. Day-rows
 *  carry no time window — the diff key is date-only now. The stub HONORS a
 *  `generated` filter in the WHERE (rendered to SQL text to detect it): the
 *  manual-row suppression test below is only meaningful if a query that still
 *  filtered `generated = true` would actually hide manual rows from the diff. */
function fakeDb(
  existing: { date: string; generated?: boolean }[],
  inserted: Record<string, unknown>[],
) {
  const dialect = new PgDialect();
  const sel = {
    from: () => sel,
    where: async (cond: unknown) => {
      const sql = dialect.sqlToQuery(cond as SQL).sql;
      const rows = sql.includes('"generated"')
        ? existing.filter((r) => r.generated !== false)
        : existing;
      return rows.map((r) => ({ date: r.date }));
    },
  };
  const ins = {
    values: async (rows: Record<string, unknown>[]) => {
      inserted.push(...rows);
    },
  };
  const upd = { set: () => ({ where: async () => undefined }) };
  // create/materialize now wrap the check-then-insert in db.transaction(...) with a
  // per-tenant advisory lock; execute() (the lock) is a no-op, transaction() runs the
  // callback against this same stub.
  const db: any = { select: () => sel, insert: () => ins, update: () => upd, execute: async () => undefined };
  db.transaction = async (fn: (tx: unknown) => Promise<unknown>) => fn(db);
  return db as never;
}

describe('SlotsService.materializeRule', () => {
  it('inserts only the missing dates as generated slots (interval mode)', async () => {
    const inserted: Record<string, unknown>[] = [];
    const svc = new SlotsService(fakeDb([{ date: '2026-06-08' }], inserted), {} as never);
    jest.spyOn(svc, 'getRule').mockResolvedValue({
      active: true,
      repeat: 'interval',
      days: [],
      intervalDays: 3,
      intervalCapacity: 10,
      anchorDate: '2026-06-08',
      horizonDays: 9,
      skipDates: [],
    });
    const n = await svc.materializeRule('t1', '2026-06-08');
    // dates: 06-08, 06-11, 06-14, 06-17 ; 06-08 already exists → 3 inserted
    expect(n).toBe(3);
    expect(inserted.map((r) => r.date)).toEqual(['2026-06-11', '2026-06-14', '2026-06-17']);
    expect(inserted.every((r) => r.generated === true)).toBe(true);
    expect(inserted.every((r) => r.capacity === 10)).toBe(true);
  });

  it("stamps each date's own capacity in weekdays mode (per-day, not a single default)", async () => {
    const inserted: Record<string, unknown>[] = [];
    const svc = new SlotsService(fakeDb([], inserted), {} as never);
    // 2026-06-08 is a Monday, 2026-06-10 a Wednesday.
    jest.spyOn(svc, 'getRule').mockResolvedValue({
      active: true,
      repeat: 'weekdays',
      days: [
        { dow: 1, capacity: 5 }, // Monday
        { dow: 3, capacity: 9 }, // Wednesday
      ],
      intervalDays: 1,
      intervalCapacity: 1,
      anchorDate: '2026-06-08',
      horizonDays: 3,
      skipDates: [],
    });
    const n = await svc.materializeRule('t1', '2026-06-08');
    expect(n).toBe(2);
    const byDate = new Map(inserted.map((r) => [r.date, r.capacity]));
    expect(byDate.get('2026-06-08')).toBe(5);
    expect(byDate.get('2026-06-10')).toBe(9);
  });

  it('the date-only diff skips a date that already has a generated row, regardless of capacity', async () => {
    const inserted: Record<string, unknown>[] = [];
    const svc = new SlotsService(fakeDb([{ date: '2026-06-08' }], inserted), {} as never);
    jest.spyOn(svc, 'getRule').mockResolvedValue({
      active: true,
      repeat: 'weekdays',
      days: [{ dow: 1, capacity: 40 }], // Monday — 2026-06-08 already exists
      intervalDays: 1,
      intervalCapacity: 1,
      anchorDate: '2026-06-08',
      horizonDays: 0,
      skipDates: [],
    });
    const n = await svc.materializeRule('t1', '2026-06-08');
    expect(n).toBe(0);
    expect(inserted).toHaveLength(0);
  });

  it('is idempotent: a second call the same "today" short-circuits with no DB writes', async () => {
    // slots.service.ts:423 — lastMaterializedDate === today (and !force) must return
    // before the existing-dates diff select or any insert ever runs.
    const selectSpy = jest.fn(() => {
      throw new Error('must not query existing dates on the idempotent short-circuit');
    });
    const insertSpy = jest.fn(() => {
      throw new Error('must not insert on the idempotent short-circuit');
    });
    const svc = new SlotsService({ select: selectSpy, insert: insertSpy } as never, {} as never);
    jest.spyOn(svc, 'getRule').mockResolvedValue({
      active: true,
      repeat: 'weekdays',
      days: [{ dow: 4, capacity: 40 }],
      intervalDays: 1,
      intervalCapacity: 10,
      anchorDate: '2026-07-01',
      horizonDays: 14,
      skipDates: [],
      lastMaterializedDate: '2026-07-15',
    });

    const first = await svc.materializeRule('t1', '2026-07-15');
    const second = await svc.materializeRule('t1', '2026-07-15');

    expect(first).toBe(0);
    expect(second).toBe(0);
    expect(selectSpy).not.toHaveBeenCalled();
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it('a manual (generated=false) day-row on a wanted date suppresses generation for that date', async () => {
    // The diff must see ANY existing row, not only generated ones — otherwise the
    // generator would add a second row on a date the farmer opened by hand,
    // breaking the one-day-row-per-(tenant,date) invariant create() enforces.
    const inserted: Record<string, unknown>[] = [];
    const svc = new SlotsService(
      fakeDb([{ date: '2026-06-08', generated: false }], inserted),
      {} as never,
    );
    jest.spyOn(svc, 'getRule').mockResolvedValue({
      active: true,
      repeat: 'weekdays',
      days: [{ dow: 1, capacity: 40 }], // Monday — 2026-06-08 has a manual row
      intervalDays: 1,
      intervalCapacity: 1,
      anchorDate: '2026-06-08',
      horizonDays: 0,
      skipDates: [],
    });
    const n = await svc.materializeRule('t1', '2026-06-08');
    expect(n).toBe(0);
    expect(inserted).toHaveLength(0);
  });
});

describe('SlotsService.create', () => {
  it('creates a day-row slot with no time window', async () => {
    const inserted: Record<string, unknown>[] = [];
    const db: any = {
      select: () => ({
        from: () => ({ where: () => ({ limit: async () => [] }) }),
      }),
      insert: () => ({
        values: (v: Record<string, unknown>) => {
          inserted.push(v);
          return {
            returning: async () => [{ id: 's1', ...v, timeFrom: null, timeTo: null }],
          };
        },
      }),
      execute: async () => undefined,
    };
    db.transaction = async (fn: (tx: unknown) => Promise<unknown>) => fn(db);
    const svc = new SlotsService(db as never, {} as never);
    const row = await svc.create('t1', { date: '2026-07-09', capacity: 40 } as never);
    expect(row).toMatchObject({ date: '2026-07-09', capacity: 40, timeFrom: null });
    expect(inserted[0]).not.toHaveProperty('timeFrom');
    expect(inserted[0]).not.toHaveProperty('timeTo');
  });

  // delivery_slots has no unique on (tenant,date): a per-tenant advisory lock, taken
  // BEFORE the existence check, is what stops two concurrent creates from both seeing
  // the date absent and inserting duplicate day-rows (doubled capacity → oversell).
  it('takes a per-tenant advisory lock before the check-then-insert', async () => {
    const order: string[] = [];
    let lockSql: SQL | undefined;
    const db: any = {
      select: () => ({ from: () => ({ where: () => ({ limit: async () => { order.push('check'); return []; } }) }) }),
      insert: () => ({ values: () => { order.push('insert'); return { returning: async () => [{ id: 's1' }] }; } }),
      execute: async (q: SQL) => { order.push('lock'); lockSql = q; },
    };
    db.transaction = async (fn: (tx: unknown) => Promise<unknown>) => fn(db);
    const svc = new SlotsService(db as never, {} as never);

    await svc.create('t1', { date: '2026-07-09', capacity: 10 } as never);

    expect(order).toEqual(['lock', 'check', 'insert']); // lock FIRST
    const rendered = new PgDialect().sqlToQuery(lockSql as SQL);
    expect(rendered.sql).toContain('pg_advisory_xact_lock');
    expect(rendered.params).toContain('t1'); // scoped to the tenant
  });

  it('rejects a second day-row on an already-open date', async () => {
    const db: any = {
      select: () => ({
        from: () => ({ where: () => ({ limit: async () => [{ id: 'existing' }] }) }),
      }),
      insert: () => {
        throw new Error('must not insert when the date is already open');
      },
      execute: async () => undefined,
    };
    db.transaction = async (fn: (tx: unknown) => Promise<unknown>) => fn(db);
    const svc = new SlotsService(db as never, {} as never);
    await expect(
      svc.create('t1', { date: '2026-07-09', capacity: 10 } as never),
    ).rejects.toThrow('Този ден вече е отворен');
  });

  it('bulk create silently skips dates that already have a day-row', async () => {
    const inserted: Record<string, unknown>[] = [];
    const db: any = {
      select: () => ({
        from: () => ({
          where: async () => [{ date: '2026-07-08' }], // Wed already open
        }),
      }),
      insert: () => ({
        values: (rows: Record<string, unknown>[]) => {
          inserted.push(...rows);
          return { returning: async () => rows.map((r, i) => ({ id: `s${i}`, ...r })) };
        },
      }),
      execute: async () => undefined,
    };
    db.transaction = async (fn: (tx: unknown) => Promise<unknown>) => fn(db);
    const svc = new SlotsService(db as never, {} as never);
    // Mon 07-06 .. Wed 07-08, weekdays [1,3] (Mon, Wed) → wants 07-06 and 07-08.
    await svc.create('t1', {
      date: '2026-07-06',
      dateTo: '2026-07-08',
      weekdays: [1, 3],
      capacity: 20,
    } as never);
    expect(inserted.map((r) => r.date)).toEqual(['2026-07-06']);
  });

  it('rejects an inverted date range (expandDates guard) without touching the DB', async () => {
    const selectSpy = jest.fn(() => {
      throw new Error('must not query when the range is invalid');
    });
    const svc = new SlotsService({ select: selectSpy, insert: jest.fn() } as never, {} as never);
    await expect(
      svc.create('t1', { date: '2026-07-12', dateTo: '2026-07-06', weekdays: [1] } as never),
    ).rejects.toThrow('Невалиден диапазон от дати');
    expect(selectSpy).not.toHaveBeenCalled();
  });
});

/** db stub for remove(): 1st select = slot lookup (.limit), 2nd select = live-order
 *  count (awaited .where). delete() records that it ran. */
function removeDb(opts: {
  slot: { id: string; date: string; generated: boolean } | null;
  liveCount: number;
  onDelete?: () => void;
}) {
  let nthSelect = 0;
  const slotSel = {
    from: () => slotSel,
    where: () => slotSel,
    limit: async () => (opts.slot ? [opts.slot] : []),
  };
  const liveSel = {
    from: () => liveSel,
    where: async () => [{ n: opts.liveCount }],
  };
  return {
    select: () => (nthSelect++ === 0 ? slotSel : liveSel),
    delete: () => ({
      where: async () => {
        opts.onDelete?.();
      },
    }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
  } as never;
}

describe('SlotsService.remove', () => {
  it('404s when the slot is not the tenant’s', async () => {
    const svc = new SlotsService(removeDb({ slot: null, liveCount: 0 }), {} as never);
    await expect(svc.remove('s1', 't1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('refuses (400) when the slot still holds a live order — never reaches delete', async () => {
    let deleted = false;
    const svc = new SlotsService(
      removeDb({
        slot: { id: 's1', date: '2026-06-30', generated: false },
        liveCount: 1,
        onDelete: () => (deleted = true),
      }),
      {} as never,
    );
    await expect(svc.remove('s1', 't1')).rejects.toBeInstanceOf(BadRequestException);
    expect(deleted).toBe(false);
  });

  it('deletes a free slot (no live order)', async () => {
    let deleted = false;
    const svc = new SlotsService(
      removeDb({
        slot: { id: 's1', date: '2026-06-30', generated: false },
        liveCount: 0,
        onDelete: () => (deleted = true),
      }),
      {} as never,
    );
    await expect(svc.remove('s1', 't1')).resolves.toEqual({ id: 's1' });
    expect(deleted).toBe(true);
  });

  it('skips the date in the rule when a generated slot is deleted', async () => {
    const svc = new SlotsService(
      removeDb({ slot: { id: 's1', date: '2026-06-30', generated: true }, liveCount: 0 }),
      {} as never,
    );
    const skip = jest
      .spyOn(svc as unknown as { addSkipDate: (t: string, d: string) => Promise<void> }, 'addSkipDate')
      .mockResolvedValue(undefined);
    await svc.remove('s1', 't1');
    expect(skip).toHaveBeenCalledWith('t1', '2026-06-30');
  });
});

describe('SlotsService.closeDay', () => {
  it('deactivates the slots it cannot delete (they hold a live order) so the day leaves the storefront', async () => {
    const updates: Record<string, unknown>[] = [];
    const db: any = {
      // delete: order-free slots removed; returns the removed ids.
      delete: () => ({ where: () => ({ returning: async () => [{ id: 'free-slot' }] }) }),
      // update: the new deactivation of the survivors — capture its patch.
      update: () => ({
        set: (patch: Record<string, unknown>) => {
          updates.push(patch);
          return { where: async () => undefined };
        },
      }),
      // select: the kept-count query.
      select: () => ({ from: () => ({ where: async () => [{ count: 1 }] }) }),
    };
    const svc = new SlotsService(db, {} as never);
    // No rule → addSkipDate is skipped (that path is covered elsewhere).
    jest.spyOn(svc as unknown as { getRule: () => Promise<null> }, 'getRule').mockResolvedValue(null);

    const res = await svc.closeDay('t1', '2026-07-11');

    expect(res).toEqual({ date: '2026-07-11', removed: 1, kept: 1 });
    // The kept (order-holding) slots on that date are set is_active=false.
    expect(updates).toContainEqual({ isActive: false });
  });
});

describe('SlotsService.saveRule', () => {
  it('deactivates a leftover generated slot on a day the new rule no longer produces', async () => {
    const setPatches: Record<string, unknown>[] = [];
    const db: any = {
      update: () => ({
        set: (patch: Record<string, unknown>) => {
          setPatches.push(patch);
          // tenants persist reads .returning(); the deliverySlots deactivation just awaits .where().
          return { where: () => ({ returning: async () => [{ slug: 'farm' }] }) };
        },
      }),
    };
    const publicCache = { del: jest.fn() };
    const svc = new SlotsService(db, publicCache as never);
    jest.spyOn(svc, 'getRule').mockResolvedValue(null);
    // Isolate saveRule from the delete/materialize DB chains — covered separately.
    jest
      .spyOn(
        svc as unknown as { deleteFutureUnbookedGenerated: () => Promise<void> },
        'deleteFutureUnbookedGenerated',
      )
      .mockResolvedValue(undefined);
    jest
      .spyOn(svc as unknown as { materializeRule: () => Promise<number> }, 'materializeRule')
      .mockResolvedValue(0);
    jest.spyOn(svc as unknown as { bgToday: () => string }, 'bgToday').mockReturnValue('2026-07-09');

    await svc.saveRule('t1', {
      active: true,
      repeat: 'weekdays',
      days: [{ dow: 4, capacity: 48 }], // Thursday only — Friday is dropped
      intervalDays: 1,
      intervalCapacity: 1,
      anchorDate: '2026-07-09',
      horizonDays: 30,
      skipDates: [],
    } as never);

    // Besides the tenants rule-persist update, the off-rule deactivation ran.
    expect(setPatches).toContainEqual({ isActive: false });
  });
});

/** db stub for findPublicBySlug: the whole select chain resolves to `rows`. */
function publicSlotsDb(
  rows: { id: string; date: string; startTime: string | null; endTime: string | null }[],
) {
  const sel = {
    from: () => sel,
    leftJoin: () => sel,
    where: () => sel,
    groupBy: () => sel,
    having: () => sel,
    orderBy: async () => rows,
  };
  return { select: () => sel } as never;
}

describe('SlotsService.findPublicBySlug — same-day cutoff', () => {
  // Today = 2026-07-02 (Thursday), first slot 14:00. Bulgaria is UTC+3 in July.
  const rows = [
    { id: 's-today', date: '2026-07-02', startTime: '14:00', endTime: '14:30' },
    { id: 's-future', date: '2026-07-09', startTime: '14:00', endTime: '14:30' },
  ];
  const publicCache = { resolveTenant: async () => ({ id: 't1', deliveryEnabled: true }) };

  afterEach(() => jest.useRealTimers());

  it('drops today entirely, even right after midnight (00:30 local)', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-01T21:30:00Z')); // 00:30 Sofia (UTC+3)
    const svc = new SlotsService(publicSlotsDb(rows), publicCache as never);
    const result = await svc.findPublicBySlug('chaika');
    expect(result.map((r) => r.id)).toEqual(['s-future']);
  });

  it('drops today regardless of how early it still is before the first slot (09:00 local)', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-02T06:00:00Z')); // 09:00 Sofia (UTC+3)
    const svc = new SlotsService(publicSlotsDb(rows), publicCache as never);
    const result = await svc.findPublicBySlug('chaika');
    expect(result.map((r) => r.id)).toEqual(['s-future']);
  });
});

describe('SlotsService.findPublicBySlug — legacy ?date= floor', () => {
  const publicCache = { resolveTenant: async () => ({ id: 't1', deliveryEnabled: true }) };

  afterEach(() => jest.useRealTimers());

  it('returns nothing for a past date (no history leak on the legacy single-day branch)', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-02T06:00:00Z')); // 09:00 Sofia (UTC+3)
    // Rows would match if the query actually ran — proves the floor short-circuits
    // before hitting the db, not that the (unfiltered) stub happens to return [].
    const rows = [{ id: 's-past', date: '2020-01-01', startTime: null, endTime: null }];
    const svc = new SlotsService(publicSlotsDb(rows), publicCache as never);
    const result = await svc.findPublicBySlug('chaika', { date: '2020-01-01' });
    expect(result).toEqual([]);
  });

  it('still returns a future date (today itself is separately excluded by the same-day cutoff)', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-02T06:00:00Z')); // 09:00 Sofia (UTC+3)
    const rows = [{ id: 's-future', date: '2026-07-09', startTime: null, endTime: null }];
    const svc = new SlotsService(publicSlotsDb(rows), publicCache as never);
    const result = await svc.findPublicBySlug('chaika', { date: '2026-07-09' });
    expect(result.map((r) => r.id)).toEqual(['s-future']);
  });
});

describe('SlotsService.findPublicBySlug — day-row shape (no time windows)', () => {
  it('passes through null start/end times for a day-row slot', async () => {
    const rows = [{ id: 's1', date: '2099-01-01', startTime: null, endTime: null }];
    const publicCache = { resolveTenant: async () => ({ id: 't1', deliveryEnabled: true }) };
    const svc = new SlotsService(publicSlotsDb(rows), publicCache as never);
    const result = await svc.findPublicBySlug('chaika');
    expect(result).toEqual([{ id: 's1', date: '2099-01-01', startTime: null, endTime: null }]);
  });
});
