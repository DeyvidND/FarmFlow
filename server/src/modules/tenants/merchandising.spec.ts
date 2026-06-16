import { resolveMerchandising, DEFAULT_MERCHANDISING } from './merchandising';

describe('resolveMerchandising', () => {
  it('defaults both features to off for missing or garbage input', () => {
    expect(resolveMerchandising(undefined)).toEqual(DEFAULT_MERCHANDISING);
    expect(resolveMerchandising(null)).toEqual(DEFAULT_MERCHANDISING);
    expect(resolveMerchandising('nope')).toEqual(DEFAULT_MERCHANDISING);
    expect(DEFAULT_MERCHANDISING.bestSellers.show).toBe(false);
    expect(DEFAULT_MERCHANDISING.recommendations.show).toBe(false);
  });

  it('coerces show flags and ignores non-booleans', () => {
    const out = resolveMerchandising({
      bestSellers: { show: true },
      recommendations: { show: 'yes' },
    });
    expect(out.bestSellers).toEqual({ show: true });
    expect(out.recommendations).toEqual({ show: false }); // non-boolean → default off
  });

  it('merges a partial config with per-block defaults', () => {
    const out = resolveMerchandising({ recommendations: { show: true } });
    expect(out.bestSellers).toEqual(DEFAULT_MERCHANDISING.bestSellers);
    expect(out.recommendations).toEqual({ show: true });
  });

  it('is idempotent (re-resolving its own output is a no-op)', () => {
    const once = resolveMerchandising({ bestSellers: { show: true } });
    expect(resolveMerchandising(once)).toEqual(once);
  });
});
