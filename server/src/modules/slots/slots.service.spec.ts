import { BadRequestException, NotFoundException } from '@nestjs/common';
import { SlotsService, PUBLIC_SLOT_COLUMNS } from './slots.service';

describe('PUBLIC_SLOT_COLUMNS', () => {
  it('exposes customerNote and never driverNote', () => {
    expect(PUBLIC_SLOT_COLUMNS).toContain('customerNote');
    expect(PUBLIC_SLOT_COLUMNS).not.toContain('driverNote');
  });
});

/** Minimal chainable db stub matching the calls materializeRule makes. Existing
 *  rows carry PG-style HH:MM:SS times — the diff key must trim them to HH:MM. */
function fakeDb(
  existing: { date: string; timeFrom?: string; timeTo?: string }[],
  inserted: Record<string, unknown>[],
) {
  const sel = {
    from: () => sel,
    where: async () =>
      existing.map((r) => ({
        date: r.date,
        timeFrom: r.timeFrom ?? '10:00:00',
        timeTo: r.timeTo ?? '12:00:00',
      })),
  };
  const ins = {
    values: async (rows: Record<string, unknown>[]) => {
      inserted.push(...rows);
    },
  };
  const upd = { set: () => ({ where: async () => undefined }) };
  return { select: () => sel, insert: () => ins, update: () => upd } as never;
}

describe('SlotsService.materializeRule', () => {
  it('inserts only the missing dates as generated slots', async () => {
    const inserted: Record<string, unknown>[] = [];
    const svc = new SlotsService(fakeDb([{ date: '2026-06-08' }], inserted), {} as never);
    jest.spyOn(svc, 'getRule').mockResolvedValue({
      active: true,
      repeat: 'interval',
      days: [],
      intervalDays: 3,
      intervalWindow: { timeFrom: '10:00', timeTo: '12:00' },
      anchorDate: '2026-06-08',
      horizonDays: 9,
      skipDates: [],
    });
    const n = await svc.materializeRule('t1', '2026-06-08');
    // dates: 06-08, 06-11, 06-14, 06-17 ; 06-08 already exists → 3 inserted
    expect(n).toBe(3);
    expect(inserted.map((r) => r.date)).toEqual(['2026-06-11', '2026-06-14', '2026-06-17']);
    expect(inserted.every((r) => r.generated === true)).toBe(true);
  });

  it('with slotMinutes the diff is per sub-slot, not per date', async () => {
    const inserted: Record<string, unknown>[] = [];
    // 10:00–12:00 split at 60 → wants 10–11 + 11–12; the 10–11 row already exists.
    const svc = new SlotsService(
      fakeDb([{ date: '2026-06-08', timeFrom: '10:00:00', timeTo: '11:00:00' }], inserted),
      {} as never,
    );
    jest.spyOn(svc, 'getRule').mockResolvedValue({
      active: true,
      repeat: 'interval',
      days: [],
      intervalDays: 7,
      intervalWindow: { timeFrom: '10:00', timeTo: '12:00' },
      anchorDate: '2026-06-08',
      horizonDays: 3,
      skipDates: [],
      slotMinutes: 60,
    });
    const n = await svc.materializeRule('t1', '2026-06-08');
    expect(n).toBe(1);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      date: '2026-06-08',
      timeFrom: '11:00',
      timeTo: '12:00',
    });
  });

  it('stamps defaultCapacity onto generated slots', async () => {
    const inserted: Record<string, unknown>[] = [];
    const svc = new SlotsService(fakeDb([], inserted), {} as never);
    jest.spyOn(svc, 'getRule').mockResolvedValue({
      active: true,
      repeat: 'interval',
      days: [],
      intervalDays: 3,
      intervalWindow: { timeFrom: '10:00', timeTo: '12:00' },
      anchorDate: '2026-06-08',
      horizonDays: 3,
      skipDates: [],
      defaultCapacity: 2,
    });
    await svc.materializeRule('t1', '2026-06-08');
    expect(inserted.length).toBeGreaterThan(0);
    expect(inserted.every((r) => r.capacity === 2)).toBe(true);
  });

  it('defaults capacity to 1 when the rule has no defaultCapacity', async () => {
    const inserted: Record<string, unknown>[] = [];
    const svc = new SlotsService(fakeDb([], inserted), {} as never);
    jest.spyOn(svc, 'getRule').mockResolvedValue({
      active: true,
      repeat: 'interval',
      days: [],
      intervalDays: 3,
      intervalWindow: { timeFrom: '10:00', timeTo: '12:00' },
      anchorDate: '2026-06-08',
      horizonDays: 3,
      skipDates: [],
    });
    await svc.materializeRule('t1', '2026-06-08');
    expect(inserted.every((r) => r.capacity === 1)).toBe(true);
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

/** db stub for findPublicBySlug: the whole select chain resolves to `rows`. */
function publicSlotsDb(rows: { id: string; date: string; startTime: string; endTime: string }[]) {
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
