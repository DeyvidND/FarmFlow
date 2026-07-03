import {
  visitorHash,
  deviceFromUA,
  isBot,
  referrerHost,
  buildFunnel,
  conversionPct,
  buildWeekdayPattern,
  labelPage,
  buildTopPages,
} from './analytics.helpers';

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
    it('extracts the host and strips leading www.', () => {
      expect(referrerHost('https://www.google.com/search?q=x')).toBe('google.com');
      expect(referrerHost('https://bing.com/search')).toBe('bing.com');
    });
    it('collapses known link-shim/mobile subdomains to their canonical host', () => {
      expect(referrerHost('https://m.facebook.com/x')).toBe('facebook.com');
      expect(referrerHost('https://l.facebook.com/x')).toBe('facebook.com');
      expect(referrerHost('https://lm.facebook.com/x')).toBe('facebook.com');
      expect(referrerHost('https://www.facebook.com/x')).toBe('facebook.com');
      expect(referrerHost('https://m.instagram.com/x')).toBe('instagram.com');
    });
    it('returns null for empty / garbage / same-site handled by caller', () => {
      expect(referrerHost('')).toBeNull();
      expect(referrerHost('not a url')).toBeNull();
    });
  });

  describe('buildFunnel', () => {
    it('orders the 5 steps and fills counts from the deepest-stage-reached array', () => {
      const steps = buildFunnel([100, 60, 25, 12, 7]);
      expect(steps.map((s) => s.key)).toEqual([
        'page_view', 'product_view', 'add_to_cart', 'checkout_start', 'purchase',
      ]);
      expect(steps[0].visitors).toBe(100);
      expect(steps[4].visitors).toBe(7);
      expect(steps[0].label).toBe('Влезли в сайта');
    });
    it('defaults missing steps to 0', () => {
      const steps = buildFunnel([10]);
      expect(steps[3].visitors).toBe(0);
    });
    // Note: buildFunnel is a pure formatter — it faithfully reflects whatever
    // stageCounts it's given. The monotonic-non-increasing guarantee ("never
    // shows a step exceeding the one before it", the actual fix for the old
    // "150% от предната стъпка" bug) comes from HOW analytics.service.ts
    // computes stageCounts (cumulative counts from a single per-visitor
    // deepest-stage max, not independent per-event-type counts) — verified
    // live in the E2E pass, not here.
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

  describe('labelPage', () => {
    it('maps known static routes to their Bulgarian label', () => {
      expect(labelPage('/')).toEqual({ path: '/', label: 'Начало' });
      expect(labelPage('/farmers')).toEqual({ path: '/farmers', label: 'Фермери' });
      expect(labelPage('/farmers/')).toEqual({ path: '/farmers', label: 'Фермери' });
    });
    it('collapses dynamic routes to one bucket', () => {
      expect(labelPage('/product/domati-cherry')).toEqual({ path: '/product', label: 'Продукт' });
      expect(labelPage('/farmer/17232f9a')).toEqual({ path: '/farmer', label: 'Профил на фермер' });
    });
    it('strips query string and hash before matching', () => {
      expect(labelPage('/shop?category=zelenchuci#top')).toEqual({ path: '/shop', label: 'Магазин' });
    });
    it('returns null for anything that is not a real storefront page', () => {
      expect(labelPage('/diag')).toBeNull();
      expect(labelPage('/js-fetch-diag')).toBeNull();
      expect(labelPage('/wp-admin')).toBeNull();
      expect(labelPage('/404')).toBeNull();
    });
  });

  describe('buildTopPages', () => {
    it('sums dynamic-route rows into one bucket and drops unknown paths (legacy fallback, no pageLabel)', () => {
      const rows = [
        { path: '/product/domati', pageLabel: null, views: 10 },
        { path: '/product/krastavici', pageLabel: null, views: 5 },
        { path: '/', pageLabel: null, views: 20 },
        { path: '/diag', pageLabel: null, views: 999 },
      ];
      const top = buildTopPages(rows);
      expect(top).toEqual([
        { path: 'Начало', label: 'Начало', views: 20 },
        { path: 'Продукт', label: 'Продукт', views: 15 },
      ]);
    });
    it('sorts by views descending and respects the limit', () => {
      const rows = [
        { path: '/about', pageLabel: null, views: 1 },
        { path: '/shop', pageLabel: null, views: 5 },
        { path: '/farmers', pageLabel: null, views: 3 },
      ];
      expect(buildTopPages(rows, 2)).toEqual([
        { path: 'Магазин', label: 'Магазин', views: 5 },
        { path: 'Фермери', label: 'Фермери', views: 3 },
      ]);
    });
    it('returns an empty array when nothing matches a real route', () => {
      expect(buildTopPages([{ path: '/diag', pageLabel: null, views: 5 }])).toEqual([]);
    });
    it('prefers the storefront-supplied pageLabel over the path-shape guess', () => {
      const rows = [
        { path: '/bundles', pageLabel: 'Пакети', views: 7 },
        { path: '/bundles/summer', pageLabel: 'Пакети', views: 3 },
      ];
      // '/bundles' isn't a chaika route at all (labelPage would drop it) — the
      // explicit label is what makes an unknown-to-the-backend storefront route work.
      expect(buildTopPages(rows)).toEqual([{ path: 'Пакети', label: 'Пакети', views: 10 }]);
    });
    it('falls back to labelPage for rows missing pageLabel, even when mixed with labeled rows', () => {
      const rows = [
        { path: '/farmers', pageLabel: null, views: 4 },
        { path: '/farmer/xyz', pageLabel: 'Профил на фермер', views: 2 },
      ];
      const top = buildTopPages(rows);
      expect(top).toEqual([
        { path: 'Фермери', label: 'Фермери', views: 4 },
        { path: 'Профил на фермер', label: 'Профил на фермер', views: 2 },
      ]);
    });
    it('merges a legacy no-pageLabel row with a new explicit-pageLabel row for the same real page', () => {
      // Regression: caught live when a site starts sending pageLabel while
      // older rows without it are still inside the analytics window — both
      // must resolve to the SAME "Начало" bucket, not fragment into two rows.
      const rows = [
        { path: '/', pageLabel: null, views: 5 }, // pre-rollout row, no pageLabel yet
        { path: '/', pageLabel: 'Начало', views: 2 }, // post-rollout row
      ];
      expect(buildTopPages(rows)).toEqual([{ path: 'Начало', label: 'Начало', views: 7 }]);
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
