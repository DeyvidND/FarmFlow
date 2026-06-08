import { slotRuleSlots, normalizeRule, migrateRule, type SlotRule } from './slot-rule';

const win = { timeFrom: '10:00', timeTo: '12:00', maxOrders: 5 };

const base: SlotRule = {
  active: true,
  repeat: 'weekdays',
  days: [
    { dow: 1, ...win },
    { dow: 3, ...win },
    { dow: 5, ...win },
  ],
  intervalDays: 3,
  intervalWindow: win,
  anchorDate: '2026-06-01',
  horizonDays: 14,
  skipDates: [],
};

describe('slotRuleSlots', () => {
  it('weekday mode picks only matching weekdays in the horizon', () => {
    const s = slotRuleSlots(base, '2026-06-08'); // 2026-06-08 is a Monday
    expect(s[0].date).toBe('2026-06-08');
    for (const g of s) {
      const dow = new Date(`${g.date}T00:00:00Z`).getUTCDay();
      expect([1, 3, 5]).toContain(dow);
    }
    expect(s[s.length - 1].date <= '2026-06-22').toBe(true);
  });

  it('uses each weekday its own window + capacity', () => {
    const r: SlotRule = {
      ...base,
      days: [
        { dow: 1, timeFrom: '10:00', timeTo: '12:00', maxOrders: 5 },
        { dow: 3, timeFrom: '16:00', timeTo: '18:00', maxOrders: 3 },
      ],
    };
    const s = slotRuleSlots(r, '2026-06-08');
    const mon = s.find((g) => g.date === '2026-06-08')!; // Monday
    const wed = s.find((g) => g.date === '2026-06-10')!; // Wednesday
    expect(mon).toMatchObject({ timeFrom: '10:00', timeTo: '12:00', maxOrders: 5 });
    expect(wed).toMatchObject({ timeFrom: '16:00', timeTo: '18:00', maxOrders: 3 });
    // Friday is not configured → no slot.
    expect(s.some((g) => g.date === '2026-06-12')).toBe(false);
  });

  it('interval mode steps every N days from the anchor using intervalWindow', () => {
    const r: SlotRule = {
      ...base,
      repeat: 'interval',
      intervalDays: 3,
      anchorDate: '2026-06-02',
      intervalWindow: { timeFrom: '09:00', timeTo: '11:00', maxOrders: 2 },
    };
    const s = slotRuleSlots(r, '2026-06-08');
    expect(s.map((g) => g.date)).toEqual([
      '2026-06-08',
      '2026-06-11',
      '2026-06-14',
      '2026-06-17',
      '2026-06-20',
    ]);
    expect(s[0]).toMatchObject({ timeFrom: '09:00', timeTo: '11:00', maxOrders: 2 });
  });

  it('excludes skipDates', () => {
    const s = slotRuleSlots({ ...base, skipDates: ['2026-06-08'] }, '2026-06-08');
    expect(s.some((g) => g.date === '2026-06-08')).toBe(false);
  });

  it('returns [] when inactive', () => {
    expect(slotRuleSlots({ ...base, active: false }, '2026-06-08')).toEqual([]);
  });
});

describe('migrateRule', () => {
  it('upgrades a legacy single-window rule to per-weekday days', () => {
    const legacy = {
      active: true,
      repeat: 'weekdays' as const,
      weekdays: [1, 5],
      intervalDays: 3,
      anchorDate: '2026-06-01',
      timeFrom: '08:00',
      timeTo: '10:00',
      maxOrders: 4,
      horizonDays: 14,
      skipDates: [],
    };
    const m = migrateRule(legacy)!;
    expect(m.days).toEqual([
      { dow: 1, timeFrom: '08:00', timeTo: '10:00', maxOrders: 4 },
      { dow: 5, timeFrom: '08:00', timeTo: '10:00', maxOrders: 4 },
    ]);
    expect(m.intervalWindow).toEqual({ timeFrom: '08:00', timeTo: '10:00', maxOrders: 4 });
  });

  it('passes a current rule through unchanged', () => {
    expect(migrateRule(base)).toBe(base);
  });

  it('returns null for null', () => {
    expect(migrateRule(null)).toBeNull();
  });
});

describe('normalizeRule', () => {
  it('preserves prior skipDates', () => {
    const prev = { ...base, skipDates: ['2026-06-10'] };
    expect(normalizeRule(base, prev).skipDates).toEqual(['2026-06-10']);
  });

  it('sorts + dedupes days by weekday', () => {
    const r = normalizeRule({
      ...base,
      days: [
        { dow: 5, ...win },
        { dow: 1, ...win },
        { dow: 1, timeFrom: '14:00', timeTo: '16:00', maxOrders: 9 },
      ],
    });
    expect(r.days.map((d) => d.dow)).toEqual([1, 5]);
    // last write wins for the duplicated weekday
    expect(r.days[0]).toMatchObject({ timeFrom: '14:00', maxOrders: 9 });
  });

  it('rejects a day with timeTo <= timeFrom', () => {
    expect(() => normalizeRule({ ...base, days: [{ dow: 1, timeFrom: '12:00', timeTo: '10:00', maxOrders: 5 }] })).toThrow();
  });

  it('rejects empty days in weekday mode', () => {
    expect(() => normalizeRule({ ...base, days: [] })).toThrow();
  });

  it('rejects an invalid interval window', () => {
    expect(() =>
      normalizeRule({ ...base, repeat: 'interval', intervalWindow: { timeFrom: '10:00', timeTo: '09:00', maxOrders: 5 } }),
    ).toThrow();
  });

  it('tolerates an invalid interval window in weekdays mode (inactive — falls back)', () => {
    const r = normalizeRule({
      ...base,
      repeat: 'weekdays',
      intervalWindow: { timeFrom: '10:00', timeTo: '09:00', maxOrders: 5 },
    });
    expect(r.intervalWindow).toEqual({ timeFrom: '10:00', timeTo: '12:00', maxOrders: 5 });
    expect(r.days.length).toBeGreaterThan(0);
  });

  it('tolerates invalid days in interval mode (inert — drops them, no throw)', () => {
    const r = normalizeRule({
      ...base,
      repeat: 'interval',
      days: [{ dow: 1, timeFrom: '12:00', timeTo: '10:00', maxOrders: 5 }],
      intervalWindow: { timeFrom: '09:00', timeTo: '11:00', maxOrders: 2 },
    });
    expect(r.days).toEqual([]);
    expect(r.intervalWindow).toMatchObject({ timeFrom: '09:00', timeTo: '11:00' });
  });

  it('accepts + migrates a legacy rule', () => {
    const legacy = {
      active: true,
      repeat: 'weekdays' as const,
      weekdays: [2, 4],
      intervalDays: 2,
      anchorDate: '2026-06-01',
      timeFrom: '10:00',
      timeTo: '12:00',
      maxOrders: 5,
      horizonDays: 14,
      skipDates: [],
    };
    const r = normalizeRule(legacy);
    expect(r.days.map((d) => d.dow)).toEqual([2, 4]);
  });
});
