import { isoWeekNumber } from './iso-week';

describe('isoWeekNumber', () => {
  it('returns ISO-8601 week numbers', () => {
    expect(isoWeekNumber(new Date('2026-01-01'))).toBe(1); // Thursday → week 1
    expect(isoWeekNumber(new Date('2026-06-09'))).toBe(24);
    expect(isoWeekNumber(new Date('2026-12-31'))).toBe(53);
  });

  it('puts a late-December date that belongs to next ISO year in week 1', () => {
    expect(isoWeekNumber(new Date('2025-12-29'))).toBe(1); // Monday of ISO week 1, 2026
  });
});
