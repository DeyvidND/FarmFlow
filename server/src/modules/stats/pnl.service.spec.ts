import { SQL, Param } from 'drizzle-orm';
import { orders } from '@fermeribg/db';
import { PnlService } from './pnl.service';

function paramValues(node: unknown, out: unknown[] = []): unknown[] {
  if (node instanceof Param) out.push(node.value);
  else if (node instanceof SQL)
    for (const c of (node as unknown as { queryChunks: unknown[] }).queryChunks) paramValues(c, out);
  else if (Array.isArray(node)) for (const c of node) paramValues(c, out);
  return out;
}

/**
 * Walk a drizzle SQL tree and pull out every embedded chunk (Column
 * references included, not just Params) — mirrors
 * routing.service.spec.ts's `flattenSql`/`hasColumn` pair, needed here to
 * prove the LATERAL join fragment actually correlates on `orders.id`
 * (a Column reference, not a bound Param).
 */
function flattenSql(node: unknown, out: unknown[] = []): unknown[] {
  if (node instanceof SQL) {
    for (const chunk of (node as unknown as { queryChunks: unknown[] }).queryChunks) flattenSql(chunk, out);
  } else if (Array.isArray(node)) {
    for (const item of node) flattenSql(item, out);
  } else {
    out.push(node);
  }
  return out;
}

function hasColumn(node: unknown, col: unknown): boolean {
  return flattenSql(node).includes(col);
}

/** Flattens a drizzle `SQL` object's (possibly nested) queryChunks into the
 *  literal SQL text it was built from — mirrors orders.status-scope.spec.ts's
 *  helper of the same name. */
function literalText(node: unknown): string {
  const n = node as { queryChunks?: unknown[]; value?: unknown } | null;
  if (!n || typeof n !== 'object') return '';
  if (Array.isArray(n.value) && n.value.every((v) => typeof v === 'string')) {
    return (n.value as string[]).join('');
  }
  if (Array.isArray(n.queryChunks)) return n.queryChunks.map(literalText).join('');
  return '';
}

/**
 * Мок, който разпознава коя от трите заявки върви по ПРОЕКЦИЯТА ѝ и записва
 * нейния WHERE. Passthrough мок не вижда SQL-а, затова tenant-scope твърденията
 * се правят върху записания клауз, а не върху върнатите редове.
 */
function makeDb(canned: {
  revenue?: unknown[];
  expenses?: unknown[];
  names?: unknown[];
  settings?: unknown[];
}) {
  const wheres: Record<string, unknown> = {};
  const joins: Record<string, unknown[]> = {};
  const tag = (proj: Record<string, unknown>) => {
    const keys = Object.keys(proj ?? {});
    if (keys.includes('deliveryStotinki')) return 'revenue';
    if (keys.includes('category')) return 'expenses';
    if (keys.includes('email')) return 'names';
    if (keys.includes('settings')) return 'settings';
    return 'other';
  };
  const rowsFor = (t: string): unknown[] =>
    t === 'revenue'
      ? (canned.revenue ?? [])
      : t === 'expenses'
        ? (canned.expenses ?? [])
        : t === 'names'
          ? (canned.names ?? [])
          : (canned.settings ?? [{ settings: null }]);

  const chain = (proj: Record<string, unknown>) => {
    const t = tag(proj);
    const b: any = {};
    for (const m of ['from', 'innerJoin', 'groupBy', 'orderBy', 'as']) b[m] = jest.fn(() => b);
    // Capture EVERY leftJoin's join-target arg (there are two on the revenue
    // query: the order-items LATERAL, then routeCourierAssignments) so a test
    // can inspect the first one instead of only trusting the mock resolved.
    b.leftJoin = jest.fn((joinTarget: unknown) => {
      (joins[t] ??= []).push(joinTarget);
      return b;
    });
    b.where = jest.fn((w: unknown) => {
      wheres[t] = w;
      return b;
    });
    b.limit = jest.fn(async () => rowsFor(t));
    b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(rowsFor(t)).then(res, rej);
    return b;
  };
  return { db: { select: jest.fn((proj: Record<string, unknown>) => chain(proj)) }, wheres, joins };
}

describe('PnlService.pnl', () => {
  it('стеснява приходите и разходите по tenant и по прозореца', async () => {
    const { db, wheres } = makeDb({});
    const svc = new PnlService(db as any);
    await svc.pnl('tenant-1', { from: '2020-06-01', to: '2020-06-30' });

    const rev = paramValues(wheres.revenue);
    expect(rev).toContain('tenant-1');
    expect(rev).toContain('2020-06-01');
    expect(rev).toContain('2020-06-30');
    expect(rev).toContain('delivered'); // само доставени поръчки

    const exp = paramValues(wheres.expenses);
    expect(exp).toContain('tenant-1');
    expect(exp).toContain('2020-06-01');
    expect(exp).toContain('2020-06-30');
  });

  it('сглобява резултата с процента от настройките и имейлите като имена', async () => {
    const { db } = makeDb({
      revenue: [{ accountId: 'acc-1', itemsStotinki: 10000, deliveryStotinki: 500 }],
      expenses: [{ accountId: 'acc-1', category: 'fuel', amountStotinki: 400 }],
      names: [{ id: 'acc-1', email: 'ivan@ferma.bg' }],
      settings: [{ settings: { stats: { infoCommissionBps: 1000 } } }],
    });
    const svc = new PnlService(db as any);
    const res = await svc.pnl('tenant-1', { from: '2020-06-01', to: '2020-06-30' });

    expect(res.commissionBps).toBe(1000);
    expect(res.revenue).toEqual({ deliveryStotinki: 500, commissionStotinki: 1000, totalStotinki: 1500 });
    expect(res.couriers[0]).toMatchObject({ name: 'ivan@ferma.bg', expenseStotinki: 400, profitStotinki: 1100 });
    expect(res.profitStotinki).toBe(1100);
    expect(res.from).toBe('2020-06-01');
    expect(res.to).toBe('2020-06-30');
  });

  it('без нито един акаунт не се пуска заявка за имена', async () => {
    const { db } = makeDb({ revenue: [{ accountId: null, itemsStotinki: 100, deliveryStotinki: 0 }] });
    const svc = new PnlService(db as any);
    const res = await svc.pnl('tenant-1', { range: '30d' });
    expect(res.unassigned.revenueStotinki).toBe(0 + res.unassigned.commissionStotinki);
    // 3 заявки максимум: приходи, разходи, настройки — без „имена".
    expect((db.select as jest.Mock).mock.calls.length).toBe(3);
  });

  it('доставката се клампва в SQL — никога отрицателна', async () => {
    const { db } = makeDb({});
    const svc = new PnlService(db as any);
    await svc.pnl('tenant-1', { range: '30d' });
    // Проекцията на приходната заявка е първият аргумент на select().
    const proj = (db.select as jest.Mock).mock.calls
      .map((c) => c[0])
      .find((p: Record<string, unknown>) => 'deliveryStotinki' in p);
    const rendered = JSON.stringify((proj.deliveryStotinki as SQL).queryChunks);
    expect(rendered).toContain('greatest(0,');
  });

  it('стоките на поръчка се сумират с LATERAL корелирана по orders.id, не с whole-table подзаявка', async () => {
    const { db, joins } = makeDb({});
    const svc = new PnlService(db as any);
    await svc.pnl('tenant-1', { range: '30d' });

    // Първият leftJoin на приходната заявка е order-items LATERAL-ът (вторият
    // е routeCourierAssignments) — виж pnl.service.ts.
    const lateralJoin = joins.revenue?.[0];
    expect(literalText(lateralJoin)).toMatch(/lateral/i);
    // Корелацията e по `orders.id` — Column референция, не bound Param, затова
    // paramValues не би я хванал; hasColumn ходи по същите queryChunks.
    expect(hasColumn(lateralJoin, orders.id)).toBe(true);
  });

  it('невалиден период гърми с 400, не смята каквото и да е', async () => {
    const { db } = makeDb({});
    const svc = new PnlService(db as any);
    await expect(svc.pnl('tenant-1', { from: '2026-07-31', to: '2026-07-01' })).rejects.toMatchObject({
      status: 400,
    });
  });
});
