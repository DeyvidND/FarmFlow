import { SQL, Param } from 'drizzle-orm';
import { PnlService } from './pnl.service';

function paramValues(node: unknown, out: unknown[] = []): unknown[] {
  if (node instanceof Param) out.push(node.value);
  else if (node instanceof SQL)
    for (const c of (node as unknown as { queryChunks: unknown[] }).queryChunks) paramValues(c, out);
  else if (Array.isArray(node)) for (const c of node) paramValues(c, out);
  return out;
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
    for (const m of ['from', 'innerJoin', 'leftJoin', 'groupBy', 'orderBy', 'as']) b[m] = jest.fn(() => b);
    b.where = jest.fn((w: unknown) => {
      wheres[t] = w;
      return b;
    });
    b.limit = jest.fn(async () => rowsFor(t));
    b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(rowsFor(t)).then(res, rej);
    return b;
  };
  return { db: { select: jest.fn((proj: Record<string, unknown>) => chain(proj)) }, wheres };
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

  it('невалиден период гърми с 400, не смята каквото и да е', async () => {
    const { db } = makeDb({});
    const svc = new PnlService(db as any);
    await expect(svc.pnl('tenant-1', { from: '2026-07-31', to: '2026-07-01' })).rejects.toMatchObject({
      status: 400,
    });
  });
});
