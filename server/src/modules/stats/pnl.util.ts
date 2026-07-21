/**
 * Чистата математика зад „приходи / разходи / печалба" в Статистика. Стои
 * отделно от SQL-а нарочно: в репото няма тестова база (всички service тестове
 * са с мокове), така че само чиста функция може да се тества истински.
 *
 * Приход = доставка (order.total − стоките) + информационна комисионна
 * (процент върху стоките). Оборотът на стоката НЕ е наш приход и се връща
 * отделно, само за контекст.
 */

/** Един ред от групираната по акаунт заявка. `accountId` NULL = доставено без
 *  назначен куриер за деня (или без courierIndex). */
export interface PnlAccountRow {
  accountId: string | null;
  itemsStotinki: number;
  deliveryStotinki: number;
}

/** Групиран разход. `accountId` NULL = общ разход. */
export interface PnlExpenseRow {
  accountId: string | null;
  category: string;
  amountStotinki: number;
}

export interface PnlCourier {
  accountId: string;
  name: string;
  deliveryStotinki: number;
  commissionStotinki: number;
  revenueStotinki: number;
  expenseStotinki: number;
  profitStotinki: number;
}

export interface PnlResult {
  commissionBps: number;
  goodsTurnoverStotinki: number;
  revenue: { deliveryStotinki: number; commissionStotinki: number; totalStotinki: number };
  expenses: { totalStotinki: number; byCategory: { category: string; amountStotinki: number }[] };
  profitStotinki: number;
  couriers: PnlCourier[];
  unassigned: { deliveryStotinki: number; commissionStotinki: number; revenueStotinki: number };
  generalExpensesStotinki: number;
}

/** Комисионна в стотинки за дадени стоки, при ставка в базисни точки (1000 = 10%). */
export function commissionOf(itemsStotinki: number, bps: number): number {
  if (!Number.isFinite(bps) || bps <= 0) return 0;
  return Math.round((itemsStotinki * bps) / 10000);
}

const FALLBACK_NAME = 'Куриер';

export function buildPnl(
  rows: PnlAccountRow[],
  expenses: PnlExpenseRow[],
  commissionBps: number,
  names: Record<string, string>,
): PnlResult {
  const bps = Number.isFinite(commissionBps) && commissionBps > 0 ? commissionBps : 0;

  // Разходите по акаунт и по категория — сборват се преди приходите, за да може
  // всеки куриерски ред да си вземе своя разход наготово.
  const expenseByAccount = new Map<string, number>();
  const expenseByCategory = new Map<string, number>();
  let generalExpensesStotinki = 0;
  let expensesTotal = 0;
  for (const e of expenses) {
    expensesTotal += e.amountStotinki;
    expenseByCategory.set(e.category, (expenseByCategory.get(e.category) ?? 0) + e.amountStotinki);
    if (e.accountId === null) generalExpensesStotinki += e.amountStotinki;
    else expenseByAccount.set(e.accountId, (expenseByAccount.get(e.accountId) ?? 0) + e.amountStotinki);
  }

  const couriers: PnlCourier[] = [];
  const unassigned = { deliveryStotinki: 0, commissionStotinki: 0, revenueStotinki: 0 };
  let goodsTurnoverStotinki = 0;
  let deliveryTotal = 0;
  // Комисионната се смята ПО РЕД и после се сумира — не върху общия оборот —
  // за да е сборът на таблицата точно равен на общия приход.
  let commissionTotal = 0;

  for (const r of rows) {
    const commission = commissionOf(r.itemsStotinki, bps);
    goodsTurnoverStotinki += r.itemsStotinki;
    deliveryTotal += r.deliveryStotinki;
    commissionTotal += commission;

    if (r.accountId === null) {
      unassigned.deliveryStotinki += r.deliveryStotinki;
      unassigned.commissionStotinki += commission;
      unassigned.revenueStotinki += r.deliveryStotinki + commission;
      continue;
    }

    const revenueStotinki = r.deliveryStotinki + commission;
    const expenseStotinki = expenseByAccount.get(r.accountId) ?? 0;
    couriers.push({
      accountId: r.accountId,
      name: names[r.accountId] ?? FALLBACK_NAME,
      deliveryStotinki: r.deliveryStotinki,
      commissionStotinki: commission,
      revenueStotinki,
      expenseStotinki,
      profitStotinki: revenueStotinki - expenseStotinki,
    });
  }

  // Куриер с разходи, но без нито една доставка в периода, пак трябва да се вижда —
  // иначе разходът му изчезва от таблицата, докато влиза в общата печалба.
  for (const [accountId, expenseStotinki] of expenseByAccount) {
    if (couriers.some((c) => c.accountId === accountId)) continue;
    couriers.push({
      accountId,
      name: names[accountId] ?? FALLBACK_NAME,
      deliveryStotinki: 0,
      commissionStotinki: 0,
      revenueStotinki: 0,
      expenseStotinki,
      profitStotinki: -expenseStotinki,
    });
  }

  couriers.sort((a, b) => b.profitStotinki - a.profitStotinki);

  const revenueTotal = deliveryTotal + commissionTotal;
  return {
    commissionBps: bps,
    goodsTurnoverStotinki,
    revenue: {
      deliveryStotinki: deliveryTotal,
      commissionStotinki: commissionTotal,
      totalStotinki: revenueTotal,
    },
    expenses: {
      totalStotinki: expensesTotal,
      byCategory: [...expenseByCategory.entries()]
        .map(([category, amountStotinki]) => ({ category, amountStotinki }))
        .sort((a, b) => b.amountStotinki - a.amountStotinki),
    },
    profitStotinki: revenueTotal - expensesTotal,
    couriers,
    unassigned,
    generalExpensesStotinki,
  };
}
