/**
 * Storefront merchandising config (settings.merchandising). Two independent,
 * opt-in features, each a simple on/off toggle:
 *   - bestSellers     → the „Най-продавани" filter chip on the shop page
 *   - recommendations → the „Често купувано заедно" picks on the cart screen
 *
 * A pure leaf module (no imports) so both the public-cache read path and the
 * tenants write path can share it without a circular import, mirroring
 * `landing.ts` / `site-contact.ts`.
 */

export interface MerchandisingBlock {
  show: boolean;
}

export interface PublicMerchandising {
  /** „Най-продавани" — best-sellers filter chip on the shop page. */
  bestSellers: MerchandisingBlock;
  /** „Често купувано заедно" — bought-together picks on the cart screen. */
  recommendations: MerchandisingBlock;
}

/** Both default off — each feature is opt-in (the owner enables it when ready),
 *  so a tenant with no saved config keeps today's storefront unchanged. */
export const DEFAULT_MERCHANDISING: PublicMerchandising = {
  bestSellers: { show: false },
  recommendations: { show: false },
};

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

function resolveBlock(raw: unknown, def: MerchandisingBlock): MerchandisingBlock {
  const r = asRecord(raw);
  return { show: typeof r.show === 'boolean' ? r.show : def.show };
}

/** Resolve stored (or incoming) merchandising config into a complete value.
 *  Idempotent — used on both the read (public profile) and write (save) paths.
 *  Missing / garbage → DEFAULT_MERCHANDISING. */
export function resolveMerchandising(raw: unknown): PublicMerchandising {
  const r = asRecord(raw);
  return {
    bestSellers: resolveBlock(r.bestSellers, DEFAULT_MERCHANDISING.bestSellers),
    recommendations: resolveBlock(r.recommendations, DEFAULT_MERCHANDISING.recommendations),
  };
}
