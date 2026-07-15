import { describe, expect, it } from 'vitest';
import { reconcileOrder, moveInOrder, dragInOrder, transferInLegs } from './route-order';

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

describe('transferInLegs', () => {
  const legs = () => [
    ['a', 'b', 'c'],
    ['x', 'y'],
  ];

  it('moves an id to another leg at a specific index (drop onto a row)', () => {
    expect(transferInLegs(legs(), { leg: 0, idx: 1 }, 1, 1)).toEqual([
      ['a', 'c'],
      ['x', 'b', 'y'],
    ]);
  });

  it('appends to the target leg when no index is given (dropdown / tail drop zone)', () => {
    expect(transferInLegs(legs(), { leg: 0, idx: 0 }, 1)).toEqual([
      ['b', 'c'],
      ['x', 'y', 'a'],
    ]);
  });

  it('can empty a leg entirely and fill another (moving every stop across)', () => {
    let cur = [['a'], ['x']];
    cur = transferInLegs(cur, { leg: 0, idx: 0 }, 1);
    expect(cur).toEqual([[], ['x', 'a']]);
  });

  it('same-leg move with an index delegates to a drag reorder', () => {
    expect(transferInLegs(legs(), { leg: 0, idx: 0 }, 0, 2)).toEqual([
      ['b', 'c', 'a'],
      ['x', 'y'],
    ]);
  });

  it('same-leg move without an index is a no-op (dropdown re-picking the current leg)', () => {
    const cur = legs();
    expect(transferInLegs(cur, { leg: 0, idx: 1 }, 0)).toBe(cur);
  });

  it('is a no-op for a missing source id or an unknown target leg', () => {
    const cur = legs();
    expect(transferInLegs(cur, { leg: 0, idx: 9 }, 1)).toBe(cur);
    expect(transferInLegs(cur, { leg: 0, idx: 0 }, 5)).toBe(cur);
  });

  it('never mutates the input arrays', () => {
    const cur = legs();
    transferInLegs(cur, { leg: 0, idx: 1 }, 1, 0);
    expect(cur).toEqual([
      ['a', 'b', 'c'],
      ['x', 'y'],
    ]);
  });
});
