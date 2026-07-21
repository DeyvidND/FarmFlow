import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { VendorFinanceSettingsService } from './vendor-finance-settings.service';

/**
 * The bug this service exists to close: `farmers.commission_rate_bps` had a panel
 * input, but `settings.vendorFinance.commissionEnabled` — the flag that rate is
 * multiplied by — had NO writer anywhere in the codebase. An operator entered
 * „Комисиона 10%", the column stored 1000, and Статистики still rendered
 * „Комисионата е изключена" forever. These tests pin the writer's two contracts:
 * it must actually write, and it must not clobber siblings.
 *
 * The captured `.set()` value is a drizzle SQL object (circular — `toEqual` on it
 * crashes jest's serializer), so we render it through PgDialect and assert on the
 * emitted SQL + bound params instead.
 */
const dialect = new PgDialect();

function makeDb(stored: unknown) {
  const setCalls: SQL[] = [];
  const db = {
    select: () => ({
      from: () => ({ where: () => ({ limit: () => Promise.resolve([{ settings: stored }]) }) }),
    }),
    update: () => ({
      set: (v: { settings: SQL }) => {
        setCalls.push(v.settings);
        return { where: () => Promise.resolve(undefined) };
      },
    }),
  };
  return { db, setCalls };
}

const svc = (stored: unknown) => {
  const { db, setCalls } = makeDb(stored);
  return { service: new VendorFinanceSettingsService(db as never), setCalls };
};

describe('VendorFinanceSettingsService', () => {
  it('reads dormant defaults when the tenant has no vendorFinance block', async () => {
    const { service } = svc({});
    await expect(service.get('t1')).resolves.toEqual({
      commissionEnabled: false,
      defaultCommissionRateBps: 0,
      subscriptionEnabled: false,
      defaultSubscriptionFeeStotinki: 0,
    });
  });

  it('reads back what is stored', async () => {
    const { service } = svc({ vendorFinance: { commissionEnabled: true, defaultCommissionRateBps: 500 } });
    const out = await service.get('t1');
    expect(out.commissionEnabled).toBe(true);
    expect(out.defaultCommissionRateBps).toBe(500);
  });

  it('writes commissionEnabled under settings.vendorFinance', async () => {
    const { service, setCalls } = svc({});
    await service.update('t1', { commissionEnabled: true });
    expect(setCalls).toHaveLength(1);
    const { sql: text, params } = dialect.sqlToQuery(setCalls[0]);
    expect(params).toEqual(expect.arrayContaining(['vendorFinance', 'commissionEnabled', 'true']));
    // `||` merge at both levels → untouched siblings (delivery, legal, stats…) survive.
    expect(text.match(/\|\|/g)?.length).toBe(2);
  });

  it('path-merges EACH key separately so one save cannot clobber another key', async () => {
    const { service, setCalls } = svc({});
    await service.update('t1', { commissionEnabled: true, defaultCommissionRateBps: 1000 });
    const { params } = dialect.sqlToQuery(setCalls[0]);
    expect(params).toEqual(
      expect.arrayContaining([
        'vendorFinance',
        'commissionEnabled',
        'true',
        'defaultCommissionRateBps',
        '1000',
      ]),
    );
    // Chained, not one wholesale vendorFinance object. Each extra key wraps the
    // previous expression, which embeds it TWICE (once in the coalesce, once in
    // the `-> key` re-read), so the `||` count doubles-plus-two per key: 2 → 6 →
    // 14. Correct, but it means this chain must stay short — it is fine for the
    // four keys this config has, not for a blob with twenty.
    expect(dialect.sqlToQuery(setCalls[0]).sql.match(/\|\|/g)?.length).toBe(6);
  });

  it('touches only the keys the payload carries', async () => {
    const { service, setCalls } = svc({ vendorFinance: { commissionEnabled: true } });
    await service.update('t1', { defaultCommissionRateBps: 750 });
    const { params } = dialect.sqlToQuery(setCalls[0]);
    expect(params).toEqual(expect.arrayContaining(['defaultCommissionRateBps', '750']));
    expect(params).not.toContain('commissionEnabled');
  });

  it('performs NO update at all for an empty patch — never blanks the block', async () => {
    const { service, setCalls } = svc({ vendorFinance: { commissionEnabled: true } });
    await service.update('t1', {});
    expect(setCalls).toHaveLength(0);
  });

  it('ignores explicitly-undefined keys rather than writing null over them', async () => {
    const { service, setCalls } = svc({});
    await service.update('t1', { commissionEnabled: undefined, defaultCommissionRateBps: 300 });
    const { params } = dialect.sqlToQuery(setCalls[0]);
    expect(params).not.toContain('commissionEnabled');
    expect(params).toEqual(expect.arrayContaining(['defaultCommissionRateBps', '300']));
  });
});
