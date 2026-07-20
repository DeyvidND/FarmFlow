import { Test, TestingModule } from '@nestjs/testing';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { CommissionService } from '../vendor-finance/commission.service';
import { PlatformMarketplaceFinanceService } from './marketplace-finance.service';

/** Chainable Drizzle mock: awaiting any builder step resolves the next queued
 *  value. `db` itself is not thenable so TestingModule.compile() won't unwrap it. */
function makeDb() {
  const queue: unknown[] = [];
  const step: any = {};
  for (const m of ['select', 'from', 'where', 'orderBy', 'groupBy']) step[m] = jest.fn(() => step);
  step.then = (resolve: (v: unknown) => void) => resolve(queue.shift());
  const db: any = { queue: (v: unknown) => queue.push(v) };
  for (const m of ['select', 'from', 'where', 'orderBy', 'groupBy']) db[m] = jest.fn(() => step);
  return db;
}

async function build(db: any, commission: Partial<CommissionService>) {
  const mod: TestingModule = await Test.createTestingModule({
    providers: [
      PlatformMarketplaceFinanceService,
      { provide: DB_TOKEN, useValue: db },
      { provide: CommissionService, useValue: commission },
    ],
  }).compile();
  return mod.get(PlatformMarketplaceFinanceService);
}

describe('PlatformMarketplaceFinanceService.listBrands', () => {
  it('maps each multi-producer tenant to its commission roll-up via ONE grouped query', async () => {
    const db = makeDb();
    // listBrands filters demos out in SQL, so every row reaching the mapper is a
    // real brand — both fixtures are non-demo. commissionEnabled/defaultRateBps now
    // come from each brand's own settings.vendorFinance (loaded with the brand).
    db.queue([
      { id: 'b1', name: 'Бранд 1', slug: 'brand-1', isDemo: false, settings: { vendorFinance: { commissionEnabled: true, defaultCommissionRateBps: 500 } } },
      { id: 'b2', name: 'Бранд 2', slug: 'brand-2', isDemo: false, settings: null },
    ]);
    // ONE grouped roll-up over both brand ids — b2 has no entries, so it's absent
    // (defaults to 0). sum() comes back as a numeric string from node-pg.
    db.queue([
      { tenantId: 'b1', farmerCount: 2, totalGrossStotinki: '10000', totalCommissionStotinki: '500' },
    ]);

    // The per-brand CommissionService.summary is no longer called — a bare stub proves it.
    const summary = jest.fn();
    const svc = await build(db, { summary } as unknown as Partial<CommissionService>);
    const brands = await svc.listBrands();

    expect(summary).not.toHaveBeenCalled();
    expect(brands).toEqual([
      {
        id: 'b1',
        name: 'Бранд 1',
        slug: 'brand-1',
        isDemo: false,
        commissionEnabled: true,
        defaultRateBps: 500,
        farmerCount: 2,
        totalGrossStotinki: 10_000,
        totalCommissionStotinki: 500,
      },
      {
        id: 'b2',
        name: 'Бранд 2',
        slug: 'brand-2',
        isDemo: false,
        commissionEnabled: false,
        defaultRateBps: 0,
        farmerCount: 0,
        totalGrossStotinki: 0,
        totalCommissionStotinki: 0,
      },
    ]);
  });
});
