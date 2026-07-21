import { buildPnl, commissionOf } from './pnl.util';

describe('commissionOf', () => {
  it('закръгля до цяла стотинка', () => {
    expect(commissionOf(12345, 1000)).toBe(1235); // 1234.5 → 1235
  });

  it('нулев или липсващ процент дава нула', () => {
    expect(commissionOf(50000, 0)).toBe(0);
    expect(commissionOf(50000, Number.NaN)).toBe(0);
  });
});

describe('buildPnl', () => {
  const names = { 'acc-1': 'ivan@ferma.bg', 'acc-2': 'petar@ferma.bg' };

  it('празен период дава нули, не null', () => {
    const r = buildPnl([], [], 1000, {});
    expect(r.revenue).toEqual({ deliveryStotinki: 0, commissionStotinki: 0, totalStotinki: 0 });
    expect(r.expenses.totalStotinki).toBe(0);
    expect(r.profitStotinki).toBe(0);
    expect(r.couriers).toEqual([]);
    expect(r.goodsTurnoverStotinki).toBe(0);
  });

  it('приход на куриер = доставка + комисионна върху неговите стоки', () => {
    const r = buildPnl(
      [{ accountId: 'acc-1', itemsStotinki: 100_00, deliveryStotinki: 5_00 }],
      [],
      1000,
      names,
    );
    expect(r.couriers).toHaveLength(1);
    expect(r.couriers[0]).toMatchObject({
      accountId: 'acc-1',
      name: 'ivan@ferma.bg',
      deliveryStotinki: 500,
      commissionStotinki: 1000,
      revenueStotinki: 1500,
      expenseStotinki: 0,
      profitStotinki: 1500,
    });
  });

  it('разходите на куриера се вадят само от неговата печалба', () => {
    const r = buildPnl(
      [
        { accountId: 'acc-1', itemsStotinki: 100_00, deliveryStotinki: 5_00 },
        { accountId: 'acc-2', itemsStotinki: 50_00, deliveryStotinki: 3_00 },
      ],
      [{ accountId: 'acc-1', category: 'fuel', amountStotinki: 400 }],
      1000,
      names,
    );
    const a1 = r.couriers.find((c) => c.accountId === 'acc-1')!;
    const a2 = r.couriers.find((c) => c.accountId === 'acc-2')!;
    expect(a1.expenseStotinki).toBe(400);
    expect(a1.profitStotinki).toBe(1500 - 400);
    expect(a2.expenseStotinki).toBe(0);
    expect(a2.profitStotinki).toBe(300 + 500);
  });

  it('общите разходи не се разпределят по куриери, но влизат в общата печалба', () => {
    const r = buildPnl(
      [{ accountId: 'acc-1', itemsStotinki: 100_00, deliveryStotinki: 5_00 }],
      [
        { accountId: null, category: 'fees', amountStotinki: 700 },
        { accountId: 'acc-1', category: 'fuel', amountStotinki: 300 },
      ],
      1000,
      names,
    );
    expect(r.generalExpensesStotinki).toBe(700);
    expect(r.couriers[0].expenseStotinki).toBe(300);
    expect(r.expenses.totalStotinki).toBe(1000);
    expect(r.revenue.totalStotinki).toBe(1500);
    expect(r.profitStotinki).toBe(500);
  });

  it('доставените без назначен куриер отиват в „неразпределени"', () => {
    const r = buildPnl(
      [
        { accountId: null, itemsStotinki: 20_00, deliveryStotinki: 2_00 },
        { accountId: 'acc-1', itemsStotinki: 10_00, deliveryStotinki: 1_00 },
      ],
      [],
      1000,
      names,
    );
    expect(r.unassigned).toEqual({ deliveryStotinki: 200, commissionStotinki: 200, revenueStotinki: 400 });
    expect(r.couriers).toHaveLength(1);
    expect(r.revenue.totalStotinki).toBe(400 + 200);
  });

  it('сборът на редовете в таблицата е точно общият приход (без разминаване от закръгляне)', () => {
    const r = buildPnl(
      [
        { accountId: 'acc-1', itemsStotinki: 3333, deliveryStotinki: 0 },
        { accountId: 'acc-2', itemsStotinki: 3333, deliveryStotinki: 0 },
      ],
      [],
      1000,
      names,
    );
    const sum = r.couriers.reduce((s, c) => s + c.revenueStotinki, 0) + r.unassigned.revenueStotinki;
    expect(sum).toBe(r.revenue.totalStotinki);
  });

  it('разходите се сумират по категория, подредени низходящо', () => {
    const r = buildPnl(
      [],
      [
        { accountId: null, category: 'fuel', amountStotinki: 100 },
        { accountId: 'acc-1', category: 'fuel', amountStotinki: 250 },
        { accountId: null, category: 'salary', amountStotinki: 900 },
      ],
      0,
      names,
    );
    expect(r.expenses.byCategory).toEqual([
      { category: 'salary', amountStotinki: 900 },
      { category: 'fuel', amountStotinki: 350 },
    ]);
  });

  it('акаунт без известен имейл пада към „Куриер"', () => {
    const r = buildPnl([{ accountId: 'acc-x', itemsStotinki: 100, deliveryStotinki: 0 }], [], 0, {});
    expect(r.couriers[0].name).toBe('Куриер');
  });
});
