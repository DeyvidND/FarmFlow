import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { type Database, tenants } from '@fermeribg/db';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { CommissionService } from '../vendor-finance/commission.service';

/** One marketplace brand (a multi-producer tenant) with its commission roll-up. */
export interface MarketplaceBrand {
  id: string;
  name: string;
  slug: string;
  isDemo: boolean;
  commissionEnabled: boolean;
  defaultRateBps: number;
  farmerCount: number;
  totalGrossStotinki: number;
  totalCommissionStotinki: number;
}

/**
 * Super-admin oversight over the (dormant) vendor-finance ledgers, one level up:
 * lists the marketplace brands (multi-producer tenants) and their commission
 * totals so the operator sees who owes what across the platform. Per-brand detail
 * (producer breakdown + monthly charges) is served by delegating to the same
 * CommissionService / VendorSubscriptionService for a chosen tenantId — the
 * platform equivalent of the tenant-scoped vendor-finance controller.
 */
@Injectable()
export class PlatformMarketplaceFinanceService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Database,
    private readonly commission: CommissionService,
  ) {}

  /** Every multi-producer tenant with its commission summary totals. The set is
   *  tiny (a handful of marketplace brands), so a summary per brand is fine. */
  async listBrands(): Promise<MarketplaceBrand[]> {
    const brands = await this.db
      .select({ id: tenants.id, name: tenants.name, slug: tenants.slug, isDemo: tenants.isDemo })
      .from(tenants)
      .where(eq(tenants.multiFarmer, true))
      .orderBy(tenants.name);

    return Promise.all(
      brands.map(async (b) => {
        const s = await this.commission.summary(b.id);
        return {
          id: b.id,
          name: b.name,
          slug: b.slug,
          isDemo: !!b.isDemo,
          commissionEnabled: s.commissionEnabled,
          defaultRateBps: s.defaultRateBps,
          farmerCount: s.farmers.length,
          totalGrossStotinki: s.totalGrossStotinki,
          totalCommissionStotinki: s.totalCommissionStotinki,
        };
      }),
    );
  }
}
