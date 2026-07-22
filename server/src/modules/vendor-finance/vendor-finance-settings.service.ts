import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { type Database, tenants } from '@fermeribg/db';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { jsonbDeepMerge } from '../../common/db/jsonb';
import {
  readVendorFinance,
  type VendorFinanceSettings,
  VENDOR_FINANCE_KEY,
} from './vendor-finance.settings';

/** The operator-editable subset — every key is optional so a PATCH can flip the
 *  switch without restating the rates (and vice-versa). */
export type VendorFinancePatch = Partial<VendorFinanceSettings>;

/**
 * Read/write for `tenants.settings.vendorFinance` — the switch that decides whether
 * the commission the operator sets per producer is actually APPLIED.
 *
 * Why this exists: the per-producer override (`farmers.commission_rate_bps`) has had
 * a panel input since the marketplace work, but the gate it is multiplied by lived
 * only in this settings blob, and NOTHING in the codebase ever wrote it — every
 * consumer was a reader. So an operator could enter „Комисиона 10%", see it stored,
 * and still watch Статистики render „Комисионата е изключена" forever, because
 * `commissionEnabled` could never become true. This is that missing writer.
 *
 * The feature stays dormant-by-default: absent settings still parse to
 * `{ commissionEnabled: false, … }`, so nothing changes until the operator flips it.
 */
@Injectable()
export class VendorFinanceSettingsService {
  constructor(@Inject(DB_TOKEN) private readonly db: Database) {}

  async get(tenantId: string): Promise<VendorFinanceSettings> {
    const [row] = await this.db
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    return readVendorFinance(row?.settings);
  }

  /**
   * Write only the keys the payload carries, each as its own atomic path-merge.
   * Per-key (not a wholesale `vendorFinance` object) so saving the rate can never
   * clobber a concurrent write to the switch — the same rule the rest of the
   * settings writers follow. See `jsonbDeepMerge`.
   */
  async update(tenantId: string, patch: VendorFinancePatch): Promise<VendorFinanceSettings> {
    const keys = (Object.keys(patch) as (keyof VendorFinanceSettings)[]).filter(
      (k) => patch[k] !== undefined,
    );
    if (keys.length) {
      let expr = jsonbDeepMerge(tenants.settings, [VENDOR_FINANCE_KEY, keys[0]], patch[keys[0]]);
      for (const k of keys.slice(1)) expr = jsonbDeepMerge(expr, [VENDOR_FINANCE_KEY, k], patch[k]);
      await this.db.update(tenants).set({ settings: expr }).where(eq(tenants.id, tenantId));
    }
    return this.get(tenantId);
  }
}
