import { visitorHash, deviceFromUA, isBot, referrerHost, buildFunnel, conversionPct, buildWeekdayPattern } from './analytics.helpers';

describe('analytics.helpers', () => {
  describe('visitorHash', () => {
    it('is stable for the same inputs', () => {
      const a = visitorHash('1.2.3.4', 'UA', '2026-07-03', 't1', 'secret');
      const b = visitorHash('1.2.3.4', 'UA', '2026-07-03', 't1', 'secret');
      expect(a).toBe(b);
      expect(a).toHaveLength(64); // sha256 hex
    });
    it('differs across days (salt rotation)', () => {
      const a = visitorHash('1.2.3.4', 'UA', '2026-07-03', 't1', 'secret');
      const b = visitorHash('1.2.3.4', 'UA', '2026-07-04', 't1', 'secret');
      expect(a).not.toBe(b);
    });
    it('differs across tenants', () => {
      const a = visitorHash('1.2.3.4', 'UA', '2026-07-03', 't1', 'secret');
      const b = visitorHash('1.2.3.4', 'UA', '2026-07-03', 't2', 'secret');
      expect(a).not.toBe(b);
    });
  });

  describe('deviceFromUA', () => {
    it('detects mobile', () => {
      expect(deviceFromUA('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)')).toBe('mobile');
      expect(deviceFromUA('Mozilla/5.0 (Linux; Android 13)')).toBe('mobile');
    });
    it('defaults to desktop', () => {
      expect(deviceFromUA('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('desktop');
      expect(deviceFromUA('')).toBe('desktop');
    });
  });

  describe('isBot', () => {
    it('flags known crawlers', () => {
      expect(isBot('Googlebot/2.1')).toBe(true);
      expect(isBot('Mozilla/5.0 (compatible; bingbot/2.0)')).toBe(true);
      expect(isBot('HeadlessChrome/120')).toBe(true);
    });
    it('passes real browsers', () => {
      expect(isBot('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)')).toBe(false);
    });
    it('treats empty UA as a bot', () => {
      expect(isBot('')).toBe(true);
    });
  });

  describe('referrerHost', () => {
    it('extracts the host', () => {
      expect(referrerHost('https://www.google.com/search?q=x')).toBe('www.google.com');
    });
    it('returns null for empty / garbage / same-site handled by caller', () => {
      expect(referrerHost('')).toBeNull();
      expect(referrerHost('not a url')).toBeNull();
    });
  });

  describe('buildFunnel', () => {
    it('orders the 5 steps and fills counts from the map', () => {
      const steps = buildFunnel({ page_view: 100, product_view: 60, add_to_cart: 25, checkout_start: 12, purchase: 7 });
      expect(steps.map((s) => s.key)).toEqual([
        'page_view', 'product_view', 'add_to_cart', 'checkout_start', 'purchase',
      ]);
      expect(steps[0].visitors).toBe(100);
      expect(steps[4].visitors).toBe(7);
      expect(steps[0].label).toBe('Влезли в сайта');
    });
    it('defaults missing steps to 0', () => {
      const steps = buildFunnel({ page_view: 10 });
      expect(steps[3].visitors).toBe(0);
    });
  });

  describe('conversionPct', () => {
    it('computes a rounded percentage', () => {
      expect(conversionPct(1, 3)).toBe(33.3);
    });
    it('returns 0 for zero visitors (no divide-by-zero)', () => {
      expect(conversionPct(0, 0)).toBe(0);
    });
    it('returns 100 when everyone converted', () => {
      expect(conversionPct(5, 5)).toBe(100);
    });
  });

  describe('buildWeekdayPattern', () => {
    it('reindexes to a Monday-first 7-entry array and fills missing days with zero', () => {
      const rows = [
        { pgDow: 5, visitors: 20, purchasers: 4 }, // Friday
        { pgDow: 0, visitors: 10, purchasers: 1 }, // Sunday
      ];
      const pattern = buildWeekdayPattern(rows);
      expect(pattern).toHaveLength(7);
      expect(pattern.map((p) => p.label)).toEqual(['Пон', 'Вто', 'Сря', 'Чет', 'Пет', 'Съб', 'Нед']);
      expect(pattern[4]).toEqual({ label: 'Пет', visitors: 20, purchasers: 4, conversionPct: 20 });
      expect(pattern[6]).toEqual({ label: 'Нед', visitors: 10, purchasers: 1, conversionPct: 10 });
      expect(pattern[0]).toEqual({ label: 'Пон', visitors: 0, purchasers: 0, conversionPct: 0 });
    });
    it('handles an empty input (no rows at all)', () => {
      const pattern = buildWeekdayPattern([]);
      expect(pattern).toHaveLength(7);
      expect(pattern.every((p) => p.visitors === 0 && p.conversionPct === 0)).toBe(true);
    });
  });
});
