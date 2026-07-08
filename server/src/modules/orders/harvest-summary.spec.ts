import { harvestSummary } from './harvest-summary';

describe('harvestSummary', () => {
  it('sums quantity per product name, largest first', () => {
    const out = harvestSummary([
      { productName: 'Кайсии 1кг', quantity: 3 },
      { productName: 'Ягоди 0.5кг', quantity: 2 },
      { productName: 'Кайсии 1кг', quantity: 4 },
    ]);
    expect(out).toEqual([
      { productName: 'Кайсии 1кг', quantity: 7 },
      { productName: 'Ягоди 0.5кг', quantity: 2 },
    ]);
  });

  it('folds a null product name to a dash bucket', () => {
    expect(harvestSummary([{ productName: null, quantity: 5 }])).toEqual([
      { productName: '—', quantity: 5 },
    ]);
  });

  it('returns an empty array for no items', () => {
    expect(harvestSummary([])).toEqual([]);
  });

  it('breaks equal-quantity ties alphabetically by product name', () => {
    expect(
      harvestSummary([
        { productName: 'Ягоди', quantity: 2 },
        { productName: 'Ананас', quantity: 2 },
      ]),
    ).toEqual([
      { productName: 'Ананас', quantity: 2 },
      { productName: 'Ягоди', quantity: 2 },
    ]);
  });
});
