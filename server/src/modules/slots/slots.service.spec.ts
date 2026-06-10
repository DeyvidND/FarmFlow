import { SlotsService, PUBLIC_SLOT_COLUMNS } from './slots.service';

describe('PUBLIC_SLOT_COLUMNS', () => {
  it('exposes customerNote and never driverNote', () => {
    expect(PUBLIC_SLOT_COLUMNS).toContain('customerNote');
    expect(PUBLIC_SLOT_COLUMNS).not.toContain('driverNote');
  });
});

/** Minimal chainable db stub matching the calls materializeRule makes. */
function fakeDb(existingDates: string[], inserted: Record<string, unknown>[]) {
  const sel = {
    from: () => sel,
    where: async () => existingDates.map((date) => ({ date })),
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
    const svc = new SlotsService(fakeDb(['2026-06-08'], inserted), {} as never);
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
});
