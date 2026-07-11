/**
 * Vendor-finance config, stored per tenant in `tenants.settings.vendorFinance`.
 * The WHOLE feature is dormant by design: with no settings written anywhere the
 * effective config is `{ commissionEnabled: false, subscriptionEnabled: false }`,
 * commission accrues at 0 bps and charge generation refuses to run. Enabling it
 * later is a settings write — no deploy, no migration.
 *
 * Money units follow the rest of the app: rate in basis points (500 = 5%), fees
 * in the same minor unit as order totals (`*_stotinki` columns).
 */
export interface VendorFinanceSettings {
  commissionEnabled: boolean;
  /** Tenant-wide default; `farmers.commission_rate_bps` overrides per farmer. */
  defaultCommissionRateBps: number;
  subscriptionEnabled: boolean;
  /** Tenant-wide default; `farmers.subscription_fee_stotinki` overrides per farmer. */
  defaultSubscriptionFeeStotinki: number;
}

/** Defensive parse of the untyped settings jsonb — absent/garbage → dormant. */
export function readVendorFinance(settings: unknown): VendorFinanceSettings {
  const raw =
    settings && typeof settings === 'object'
      ? ((settings as Record<string, unknown>).vendorFinance as Record<string, unknown> | undefined)
      : undefined;
  const num = (v: unknown): number =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
  return {
    commissionEnabled: raw?.commissionEnabled === true,
    // Cap the tenant default at 10000 bps (100%) for parity with the per-farmer
    // override (`create-farmer.dto` @Max(10000)) — a settings typo like 50000
    // can't produce 5×-gross commission when the feature goes live.
    defaultCommissionRateBps: Math.min(num(raw?.defaultCommissionRateBps), 10_000),
    subscriptionEnabled: raw?.subscriptionEnabled === true,
    defaultSubscriptionFeeStotinki: num(raw?.defaultSubscriptionFeeStotinki),
  };
}
