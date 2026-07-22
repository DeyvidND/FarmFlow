import { expandStockLines } from './order-bundle.util';

describe('expandStockLines', () => {
  it('passes ordinary lines through unchanged', () => {
    const out = expandStockLines([{ productId: 'p1', quantity: 2 }], new Map());
    expect(out).toEqual([{ productId: 'p1', quantity: 2 }]);
  });

  it('replaces a basket with its members, multiplied by the line quantity', () => {
    const members = new Map([
      ['b1', [
        { productId: 'p1', quantity: 2 },
        { productId: 'p2', quantity: 1 },
      ]],
    ]);
    const out = expandStockLines([{ productId: 'b1', quantity: 3 }], members);
    expect(out).toEqual([
      { productId: 'p1', quantity: 6 },
      { productId: 'p2', quantity: 3 },
    ]);
  });

  it('never charges stock to the basket product itself', () => {
    const members = new Map([['b1', [{ productId: 'p1', quantity: 1 }]]]);
    const out = expandStockLines([{ productId: 'b1', quantity: 1 }], members);
    expect(out.map((l) => l.productId)).not.toContain('b1');
  });

  it('merges a product ordered both loose and inside a basket', () => {
    const members = new Map([['b1', [{ productId: 'p1', quantity: 2 }]]]);
    const out = expandStockLines(
      [
        { productId: 'p1', quantity: 1 },
        { productId: 'b1', quantity: 2 },
      ],
      members,
    );
    expect(out).toEqual([{ productId: 'p1', quantity: 5 }]);
  });

  it('keeps first-seen order so the caller stays deterministic', () => {
    const members = new Map([['b1', [{ productId: 'p2', quantity: 1 }]]]);
    const out = expandStockLines(
      [
        { productId: 'p1', quantity: 1 },
        { productId: 'b1', quantity: 1 },
        { productId: 'p3', quantity: 1 },
      ],
      members,
    );
    expect(out.map((l) => l.productId)).toEqual(['p1', 'p2', 'p3']);
  });

  it('contributes nothing for a basket with no members', () => {
    const out = expandStockLines([{ productId: 'b1', quantity: 1 }], new Map([['b1', []]]));
    expect(out).toEqual([]);
  });
});
