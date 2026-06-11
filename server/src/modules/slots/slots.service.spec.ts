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
      intervalWindow: { timeFrom: '10:00', timeTo: '12:00', maxOrders: 5 },
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
      intervalWindow: { timeFrom: '10:00', timeTo: '12:00', maxOrders: 5 },
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
});
