import { resolveLanding, DEFAULT_LANDING } from './landing';

describe('resolveLanding', () => {
  it('returns defaults (all cats / 3 farmers / 4 latest) for missing or garbage input', () => {
    expect(resolveLanding(undefined)).toEqual(DEFAULT_LANDING);
    expect(resolveLanding(null)).toEqual(DEFAULT_LANDING);
    expect(resolveLanding('nope')).toEqual(DEFAULT_LANDING);
    expect(DEFAULT_LANDING.categories.count).toBe(0); // 0 = all
    expect(DEFAULT_LANDING.farmers.count).toBe(3);
    expect(DEFAULT_LANDING.latest.count).toBe(4);
  });

  it('clamps counts to range and coerces show', () => {
    const out = resolveLanding({
      categories: { show: false, count: 99 },
      farmers: { show: true, count: -5 },
      latest: { show: true, count: 3.5 },
    });
    expect(out.categories).toEqual({ show: false, count: 12 }); // capped at 12
    expect(out.farmers).toEqual({ show: true, count: 1 }); // farmers min is 1
    expect(out.latest).toEqual({ show: true, count: 4 }); // non-integer → default
  });

  it('keeps categories.count 0 (all) and allows 0 only for categories', () => {
    expect(resolveLanding({ categories: { count: 0 } }).categories.count).toBe(0);
    expect(resolveLanding({ farmers: { count: 0 } }).farmers.count).toBe(1); // clamped up
    expect(resolveLanding({ latest: { count: 0 } }).latest.count).toBe(1);
  });

  it('merges partial config with per-block defaults', () => {
    const out = resolveLanding({ farmers: { show: false } });
    expect(out.categories).toEqual(DEFAULT_LANDING.categories);
    expect(out.latest).toEqual(DEFAULT_LANDING.latest);
    expect(out.farmers).toEqual({ show: false, count: 3 }); // count falls back to default
  });

  it('defaults reviews to off with no picks', () => {
    expect(DEFAULT_LANDING.reviews).toEqual({ show: false, ids: [] });
    expect(resolveLanding(undefined).reviews).toEqual({ show: false, ids: [] });
  });

  it('coerces reviews.show, dedupes ids, drops non-strings, caps at 12', () => {
    const ids = Array.from({ length: 15 }, (_, i) => `id${i}`);
    const out = resolveLanding({
      reviews: { show: true, ids: [...ids, 'id0', 5, null] },
    });
    expect(out.reviews.show).toBe(true);
    expect(out.reviews.ids).toHaveLength(12);
    expect(out.reviews.ids[0]).toBe('id0');
    expect(new Set(out.reviews.ids).size).toBe(12); // deduped
  });
});
