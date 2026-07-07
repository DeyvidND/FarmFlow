import {
  migrateRule,
  normalizeRule,
  slotRuleSlots,
  clampCapacity,
  slotIsFull,
  isoAddDays,
  type SlotRule,
} from './slot-rule';

describe('isoAddDays', () => {
  it('adds days without TZ drift', () => {
    expect(isoAddDays('2026-06-08', 1)).toBe('2026-06-09');
    expect(isoAddDays('2026-06-08', 7)).toBe('2026-06-15');
    expect(isoAddDays('2026-01-31', 1)).toBe('2026-02-01');
  });
});

describe('clampCapacity', () => {
  it('clamps to [1,500]', () => {
    expect(clampCapacity(undefined)).toBe(1);
    expect(clampCapacity(0)).toBe(1);
    expect(clampCapacity(40)).toBe(40);
    expect(clampCapacity(9999)).toBe(500);
  });
});

describe('slotIsFull', () => {
  it('compares booked against clamped capacity', () => {
    expect(slotIsFull(0, 1)).toBe(false);
    expect(slotIsFull(1, 1)).toBe(true);
    expect(slotIsFull(1, 2)).toBe(false);
    expect(slotIsFull(2, 2)).toBe(true);
    // capacity 0 clamps to 1 → one booked fills it
    expect(slotIsFull(1, 0)).toBe(true);
  });
});

describe('migrateRule', () => {
  it('passes a current day-capacity rule through unchanged', () => {
    const rule: SlotRule = {
      active: true, repeat: 'weekdays',
      days: [{ dow: 4, capacity: 40 }],
      intervalDays: 1, intervalCapacity: 10,
      anchorDate: '2026-07-01', horizonDays: 28, skipDates: [],
    };
    expect(migrateRule(rule)).toEqual(rule);
  });

  it('upgrades a windowed rule: day capacity = subslots × defaultCapacity', () => {
    // 10:00–18:00 at 60-min slots = 8 subslots; defaultCapacity 5 → 40.
    const old = {
      active: true, repeat: 'weekdays',
      days: [{ dow: 4, timeFrom: '10:00', timeTo: '18:00' }],
      intervalDays: 1, intervalWindow: { timeFrom: '10:00', timeTo: '12:00' },
      anchorDate: '2026-07-01', slotMinutes: 60, defaultCapacity: 5,
      horizonDays: 28, skipDates: [],
    };
    const m = migrateRule(old)!;
    expect(m.days).toEqual([{ dow: 4, capacity: 40 }]);
    // interval window 10–12 at 60 min = 2 subslots × 5 = 10.
    expect(m.intervalCapacity).toBe(10);
  });

  it('upgrades a windowed rule without slotMinutes: capacity = defaultCapacity', () => {
    const old = {
      active: true, repeat: 'weekdays',
      days: [{ dow: 1, timeFrom: '10:00', timeTo: '12:00' }],
      intervalDays: 3, intervalWindow: { timeFrom: '10:00', timeTo: '12:00' },
      anchorDate: '2026-07-01', defaultCapacity: 3, horizonDays: 28, skipDates: [],
    };
    expect(migrateRule(old)!.days).toEqual([{ dow: 1, capacity: 3 }]);
  });

  it('upgrades the legacy global-window shape (weekdays array)', () => {
    const legacy = { active: true, repeat: 'weekdays', weekdays: [1, 4], timeFrom: '10:00', timeTo: '12:00', anchorDate: '2026-07-01', horizonDays: 28, skipDates: [] };
    expect(migrateRule(legacy)!.days).toEqual([
      { dow: 1, capacity: 1 },
      { dow: 4, capacity: 1 },
    ]);
  });

  it('returns null for null/undefined', () => {
    expect(migrateRule(null)).toBeNull();
    expect(migrateRule(undefined)).toBeNull();
  });
});

describe('slotRuleSlots', () => {
  const base: SlotRule = {
    active: true, repeat: 'weekdays',
    days: [{ dow: 4, capacity: 40 }], // Thursday
    intervalDays: 1, intervalCapacity: 10,
    anchorDate: '2026-07-01', horizonDays: 14, skipDates: [],
  };
  it('emits ONE GenSlot per matching date with the day capacity', () => {
    // 2026-07-07 is a Tuesday; Thursdays in [07-07, 07-21]: 07-09, 07-16.
    expect(slotRuleSlots(base, '2026-07-07')).toEqual([
      { date: '2026-07-09', capacity: 40 },
      { date: '2026-07-16', capacity: 40 },
    ]);
  });
  it('respects skipDates', () => {
    expect(slotRuleSlots({ ...base, skipDates: ['2026-07-09'] }, '2026-07-07'))
      .toEqual([{ date: '2026-07-16', capacity: 40 }]);
  });
  it('interval mode uses intervalCapacity', () => {
    const r: SlotRule = { ...base, repeat: 'interval', intervalDays: 7, anchorDate: '2026-07-09' };
    expect(slotRuleSlots(r, '2026-07-07')).toEqual([
      { date: '2026-07-09', capacity: 10 },
      { date: '2026-07-16', capacity: 10 },
    ]);
  });
  it('inactive rule → []', () => {
    expect(slotRuleSlots({ ...base, active: false }, '2026-07-07')).toEqual([]);
  });
});

describe('normalizeRule', () => {
  it('requires ≥1 day in weekdays mode', () => {
    expect(() => normalizeRule({ active: true, repeat: 'weekdays', days: [], anchorDate: '2026-07-01' }))
      .toThrow('Избери поне един ден от седмицата');
  });
  it('clamps day capacities and preserves prev skipDates', () => {
    const prev = { skipDates: ['2026-07-09'] } as unknown as SlotRule;
    const r = normalizeRule(
      { active: true, repeat: 'weekdays', days: [{ dow: 4, capacity: 9999 }], anchorDate: '2026-07-01' },
      prev,
    );
    expect(r.days).toEqual([{ dow: 4, capacity: 500 }]);
    expect(r.skipDates).toEqual(['2026-07-09']);
  });
});
