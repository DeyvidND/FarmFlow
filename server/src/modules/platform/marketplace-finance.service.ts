import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, isNotNull, ne, sql } from 'drizzle-orm';
import { type Database, tenants, commissionEntries } from '@fermeribg/db';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { CommissionService } from '../vendor-finance/commission.service';
import { readVendorFinance } from '../vendor-finance/vendor-finance.settings';

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

  /** Every REAL multi-producer tenant with its commission summary totals. Demo
   *  brands are sandbox data with no real finance, so they're excluded here (they
   *  still exist, just not in the marketplace money view). The set is tiny (a
   *  handful of brands), so a summary per brand is fine. */
  async listBrands(): Promise<MarketplaceBrand[]> {
    const brands = await this.db
      .select({
        id: tenants.id,
        name: tenants.name,
        slug: tenants.slug,
        isDemo: tenants.isDemo,
        settings: tenants.settings,
      })
      .from(tenants)
      .where(and(eq(tenants.multiFarmer, true), eq(tenants.isDemo, false)))
      .orderBy(tenants.name);

    if (brands.length === 0) return [];

    // ONE grouped roll-up over the whole brand set instead of a 2-query
    // CommissionService.summary per brand (1 + 2N → 2). Mirrors summary's
    // tenant-scoped totals: non-voided entries, one distinct-farmer count and
    // gross/commission sum per tenant. commissionEnabled/defaultRateBps come from
    // each brand's own settings (loaded above), so no extra per-brand tenant read.
    const brandIds = brands.map((b) => b.id);
    const rollups = await this.db
      .select({
        tenantId: commissionEntries.tenantId,
        farmerCount: sql<number>`count(distinct ${commissionEntries.farmerId})::int`,
        totalGrossStotinki: sql<string>`coalesce(sum(${commissionEntries.grossStotinki}), 0)`,
        totalCommissionStotinki: sql<string>`coalesce(sum(${commissionEntries.commissionStotinki}), 0)`,
      })
      .from(commissionEntries)
      .where(
        and(
          inArray(commissionEntries.tenantId, brandIds),
          ne(commissionEntries.status, 'voided'),
          isNotNull(commissionEntries.farmerId),
        ),
      )
      .groupBy(commissionEntries.tenantId);
    const byTenant = new Map(rollups.map((r) => [r.tenantId, r]));

    return brands.map((b) => {
      const vf = readVendorFinance(b.settings);
      const roll = byTenant.get(b.id);
      return {
        id: b.id,
        name: b.name,
        slug: b.slug,
        isDemo: !!b.isDemo,
        commissionEnabled: vf.commissionEnabled,
        defaultRateBps: vf.defaultCommissionRateBps,
        farmerCount: roll?.farmerCount ?? 0,
        totalGrossStotinki: Number(roll?.totalGrossStotinki ?? 0),
        totalCommissionStotinki: Number(roll?.totalCommissionStotinki ?? 0),
      };
    });
  }
}
