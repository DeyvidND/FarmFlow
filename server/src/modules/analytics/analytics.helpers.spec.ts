import { visitorHash, deviceFromUA, isBot, referrerHost, buildFunnel } from './analytics.helpers';

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
});
