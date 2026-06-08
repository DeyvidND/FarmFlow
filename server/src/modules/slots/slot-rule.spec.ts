import { slotRuleDates, normalizeRule, type SlotRule } from './slot-rule';

const base: SlotRule = {
  active: true,
  repeat: 'weekdays',
  weekdays: [1, 3, 5],
  intervalDays: 3,
  anchorDate: '2026-06-01',
  timeFrom: '10:00',
  timeTo: '12:00',
  maxOrders: 5,
  horizonDays: 14,
  skipDates: [],
};

describe('slotRuleDates', () => {
  it('weekday mode picks only matching weekdays in the horizon', () => {
    const d = slotRuleDates(base, '2026-06-08'); // 2026-06-08 is a Monday
    expect(d[0]).toBe('2026-06-08');
    for (const iso of d) {
      const dow = new Date(`${iso}T00:00:00Z`).getUTCDay();
      expect([1, 3, 5]).toContain(dow);
    }
    expect(d[d.length - 1] <= '2026-06-22').toBe(true);
  });

  it('interval mode steps every N days from the anchor', () => {
    const r = { ...base, repeat: 'interval' as const, intervalDays: 3, anchorDate: '2026-06-02' };
    const d = slotRuleDates(r, '2026-06-08');
    expect(d).toEqual(['2026-06-08', '2026-06-11', '2026-06-14', '2026-06-17', '2026-06-20']);
  });

  it('excludes skipDates', () => {
    const d = slotRuleDates({ ...base, skipDates: ['2026-06-08'] }, '2026-06-08');
    expect(d).not.toContain('2026-06-08');
  });

  it('returns [] when inactive', () => {
    expect(slotRuleDates({ ...base, active: false }, '2026-06-08')).toEqual([]);
  });
});

describe('normalizeRule', () => {
  it('preserves prior skipDates', () => {
    const prev = { ...base, skipDates: ['2026-06-10'] };
    expect(normalizeRule(base, prev).skipDates).toEqual(['2026-06-10']);
  });
  it('rejects timeTo <= timeFrom', () => {
    expect(() => normalizeRule({ ...base, timeTo: '09:00' })).toThrow();
  });
  it('rejects empty weekdays in weekday mode', () => {
    expect(() => normalizeRule({ ...base, weekdays: [] })).toThrow();
  });
});
