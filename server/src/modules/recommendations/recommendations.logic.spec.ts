import { assembleCartPicks } from './recommendations.logic';
import type { PublicProduct } from '@farmflow/types';

/** Minimal public product for the assembly logic (only id + featured matter). */
const p = (id: string, featured = false): PublicProduct =>
  ({ id, featured }) as unknown as PublicProduct;

const ids = (out: PublicProduct[]) => out.map((x) => x.id);

describe('assembleCartPicks', () => {
  const catalog = [p('a'), p('b'), p('c'), p('d'), p('e')];
  const base = {
    catalog,
    soldOutIds: new Set<string>(),
    cartIds: new Set<string>(),
    coOccurringIds: [] as string[],
    bestSellerIds: [] as string[],
    limit: 3,
  };

  it('returns bought-together picks first, in their ranking order', () => {
    const out = assembleCartPicks({ ...base, coOccurringIds: ['c', 'a', 'b'] });
    expect(ids(out)).toEqual(['c', 'a', 'b']);
  });

  it('caps at the limit', () => {
    const out = assembleCartPicks({ ...base, coOccurringIds: ['a', 'b', 'c', 'd', 'e'] });
    expect(out).toHaveLength(3);
  });

  it('never recommends items already in the cart (and fills from elsewhere)', () => {
    const out = assembleCartPicks({
      ...base,
      cartIds: new Set(['a', 'b']),
      coOccurringIds: ['a', 'b', 'c', 'd'],
    });
    // a/b dropped (in cart); c,d kept; the 3rd slot is filled from catalog order (e).
    expect(ids(out)).toEqual(['c', 'd', 'e']);
    expect(ids(out)).not.toContain('a');
    expect(ids(out)).not.toContain('b');
  });

  it('never recommends sold-out products', () => {
    const out = assembleCartPicks({
      ...base,
      soldOutIds: new Set(['c']),
      coOccurringIds: ['c', 'd', 'e'],
    });
    // c dropped (sold out); d,e kept; 3rd slot filled from catalog order (a).
    expect(ids(out)).toEqual(['d', 'e', 'a']);
    expect(ids(out)).not.toContain('c');
  });

  it('ignores ids that are not in the catalog (stale cart entries)', () => {
    const out = assembleCartPicks({ ...base, coOccurringIds: ['ghost', 'a'] });
    expect(ids(out)).not.toContain('ghost');
    expect(ids(out)[0]).toBe('a'); // the only real co-occurrence pick leads
  });

  it('falls back to best-sellers when co-occurrence is short', () => {
    const out = assembleCartPicks({
      ...base,
      coOccurringIds: ['a'],
      bestSellerIds: ['b', 'c'],
    });
    expect(ids(out)).toEqual(['a', 'b', 'c']);
  });

  it('falls back to featured-first then catalog order when still short', () => {
    const out = assembleCartPicks({
      ...base,
      catalog: [p('a'), p('b'), p('c', true), p('d'), p('e')],
      coOccurringIds: [],
      bestSellerIds: [],
    });
    // featured 'c' jumps first; the rest keep catalog order.
    expect(ids(out)).toEqual(['c', 'a', 'b']);
  });

  it('dedupes across the three sources (no product appears twice)', () => {
    const out = assembleCartPicks({
      ...base,
      coOccurringIds: ['a'],
      bestSellerIds: ['a', 'b'],
    });
    // 'a' is in both sources but appears once; the 3rd slot fills from catalog (c).
    expect(ids(out)).toEqual(['a', 'b', 'c']);
    expect(new Set(ids(out)).size).toBe(out.length);
    expect(ids(out).filter((x) => x === 'a')).toHaveLength(1);
  });

  it('returns empty when nothing is eligible', () => {
    const out = assembleCartPicks({
      ...base,
      cartIds: new Set(['a', 'b', 'c', 'd', 'e']),
      coOccurringIds: ['a', 'b'],
      bestSellerIds: ['c'],
    });
    expect(out).toEqual([]);
  });
});
