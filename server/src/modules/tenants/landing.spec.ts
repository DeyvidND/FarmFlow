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
    expect(out.categories).toEqual({ show: false, mode: 'auto', count: 12, ids: [] }); // capped at 12
    expect(out.farmers).toEqual({ show: true, mode: 'auto', count: 1, ids: [] }); // farmers min is 1
    expect(out.latest).toEqual({ show: true, mode: 'auto', count: 4, ids: [] }); // non-integer → default
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
    expect(out.farmers).toEqual({ show: false, mode: 'auto', count: 3, ids: [] });
  });

  it('defaults every dynamic block to auto mode with no picks', () => {
    expect(DEFAULT_LANDING.categories.mode).toBe('auto');
    expect(DEFAULT_LANDING.farmers).toEqual({ show: true, mode: 'auto', count: 3, ids: [] });
  });

  it('legacy config without mode/ids resolves to auto (renders as before)', () => {
    const out = resolveLanding({
      categories: { show: true, count: 0 },
      farmers: { show: true, count: 3 },
      latest: { show: true, count: 4 },
    });
    expect(out).toEqual(DEFAULT_LANDING);
  });

  it('keeps manual mode and an ordered/deduped/capped id list per block', () => {
    const ids = Array.from({ length: 15 }, (_, i) => `id${i}`);
    const out = resolveLanding({
      farmers: { show: true, mode: 'manual', count: 3, ids: [...ids, 'id0', 7, null] },
    });
    expect(out.farmers.mode).toBe('manual');
    expect(out.farmers.ids).toHaveLength(12); // capped
    expect(out.farmers.ids[0]).toBe('id0'); // order preserved
    expect(new Set(out.farmers.ids).size).toBe(12); // deduped, non-strings dropped
  });

  it('coerces an unknown mode value to auto', () => {
    expect(resolveLanding({ latest: { mode: 'bogus' } }).latest.mode).toBe('auto');
    expect(resolveLanding({ latest: { mode: 'manual' } }).latest.mode).toBe('manual');
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
