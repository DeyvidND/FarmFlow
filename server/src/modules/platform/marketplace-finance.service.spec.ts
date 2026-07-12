import { Test, TestingModule } from '@nestjs/testing';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { CommissionService } from '../vendor-finance/commission.service';
import { PlatformMarketplaceFinanceService } from './marketplace-finance.service';

/** Chainable Drizzle mock: awaiting any builder step resolves the next queued
 *  value. `db` itself is not thenable so TestingModule.compile() won't unwrap it. */
function makeDb() {
  const queue: unknown[] = [];
  const step: any = {};
  for (const m of ['select', 'from', 'where', 'orderBy']) step[m] = jest.fn(() => step);
  step.then = (resolve: (v: unknown) => void) => resolve(queue.shift());
  const db: any = { queue: (v: unknown) => queue.push(v) };
  for (const m of ['select', 'from', 'where', 'orderBy']) db[m] = jest.fn(() => step);
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
  it('maps each multi-producer tenant to its commission roll-up', async () => {
    const db = makeDb();
    db.queue([
      { id: 'b1', name: 'Бранд 1', slug: 'brand-1', isDemo: false },
      { id: 'b2', name: 'Бранд 2', slug: 'brand-2', isDemo: true },
    ]);
    const summary = jest.fn(async (tenantId: string) =>
      tenantId === 'b1'
        ? {
            commissionEnabled: true,
            defaultRateBps: 500,
            farmers: [{ farmerId: 'f1' }, { farmerId: 'f2' }],
            totalGrossStotinki: 10_000,
            totalCommissionStotinki: 500,
          }
        : {
            commissionEnabled: false,
            defaultRateBps: 0,
            farmers: [],
            totalGrossStotinki: 0,
            totalCommissionStotinki: 0,
          },
    );

    const svc = await build(db, { summary } as unknown as Partial<CommissionService>);
    const brands = await svc.listBrands();

    expect(summary).toHaveBeenCalledWith('b1');
    expect(summary).toHaveBeenCalledWith('b2');
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
        isDemo: true,
        commissionEnabled: false,
        defaultRateBps: 0,
        farmerCount: 0,
        totalGrossStotinki: 0,
        totalCommissionStotinki: 0,
      },
    ]);
  });
});
