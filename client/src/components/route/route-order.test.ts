import { describe, expect, it } from 'vitest';
import { reconcileOrder, moveInOrder, dragInOrder } from './route-order';

const stop = (id: string) => ({ id });

describe('reconcileOrder', () => {
  it('returns the server order unchanged when there is no override', () => {
    const server = [stop('a'), stop('b'), stop('c')];
    expect(reconcileOrder(server, null)).toBe(server);
  });

  it('applies the saved manual order to still-present stops', () => {
    const server = [stop('a'), stop('b'), stop('c')];
    expect(reconcileOrder(server, ['c', 'a', 'b']).map((s) => s.id)).toEqual(['c', 'a', 'b']);
  });

  it('appends stops added since the order was saved, in server order', () => {
    const server = [stop('a'), stop('b'), stop('c'), stop('d')];
    // Saved order knew only b, a — c and d are new and keep server order at the end.
    expect(reconcileOrder(server, ['b', 'a']).map((s) => s.id)).toEqual(['b', 'a', 'c', 'd']);
  });

  it('drops saved ids that are no longer in the server set', () => {
    const server = [stop('a'), stop('c')]; // 'b' was cancelled/removed
    expect(reconcileOrder(server, ['c', 'b', 'a']).map((s) => s.id)).toEqual(['c', 'a']);
  });

  it('handles an empty server set', () => {
    expect(reconcileOrder([], ['a', 'b'])).toEqual([]);
  });
});

describe('moveInOrder', () => {
  it('moves an item up', () => {
    expect(moveInOrder(['a', 'b', 'c'], 2, -1)).toEqual(['a', 'c', 'b']);
  });

  it('moves an item down', () => {
    expect(moveInOrder(['a', 'b', 'c'], 0, 1)).toEqual(['b', 'a', 'c']);
  });

  it('is a no-op moving the first item up', () => {
    expect(moveInOrder(['a', 'b', 'c'], 0, -1)).toEqual(['a', 'b', 'c']);
  });

  it('is a no-op moving the last item down', () => {
    expect(moveInOrder(['a', 'b', 'c'], 2, 1)).toEqual(['a', 'b', 'c']);
  });
});

describe('dragInOrder', () => {
  it('moves an item to a later position', () => {
    expect(dragInOrder(['a', 'b', 'c', 'd'], 0, 2)).toEqual(['b', 'c', 'a', 'd']);
  });

  it('moves an item to an earlier position', () => {
    expect(dragInOrder(['a', 'b', 'c', 'd'], 3, 1)).toEqual(['a', 'd', 'b', 'c']);
  });

  it('is a no-op when from === to', () => {
    expect(dragInOrder(['a', 'b', 'c'], 1, 1)).toEqual(['a', 'b', 'c']);
  });
});
