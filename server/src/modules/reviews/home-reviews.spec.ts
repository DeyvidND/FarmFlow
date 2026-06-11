import { orderReviewsByIds } from './home-reviews';

const row = (id: string) => ({ id, body: id });

describe('orderReviewsByIds', () => {
  it('returns rows in pick order, dropping ids with no matching row', () => {
    const rows = [row('b'), row('a'), row('c')];
    expect(orderReviewsByIds(['a', 'x', 'c'], rows).map((r) => r.id)).toEqual(['a', 'c']);
  });

  it('ignores rows whose id is not in ids', () => {
    const rows = [row('a'), row('z')];
    expect(orderReviewsByIds(['a'], rows).map((r) => r.id)).toEqual(['a']);
  });

  it('returns [] for empty ids', () => {
    expect(orderReviewsByIds([], [row('a')])).toEqual([]);
  });
});
