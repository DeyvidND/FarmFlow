/**
 * Storefront landing-page block config (settings.landing). Each of the three
 * *dynamic* home blocks — categories, farmers, latest offers — can be shown or
 * hidden and capped to N items from the admin panel. A pure leaf module (no
 * imports) so both the public-cache read path and the tenants write path can
 * share it without a circular import, mirroring `site-contact.ts`.
 */

export interface LandingBlock {
  show: boolean;
  /** Items shown. For `categories`, 0 means "all"; farmers/latest are >= 1. */
  count: number;
}

export interface PublicLanding {
  categories: LandingBlock;
  farmers: LandingBlock;
  latest: LandingBlock;
}

/** Defaults mirror the storefront's pre-config hardcoded behavior, so a tenant
 *  with no saved config renders identically: all categories, 3 farmers, 4 latest. */
export const DEFAULT_LANDING: PublicLanding = {
  categories: { show: true, count: 0 }, // 0 = all categories
  farmers: { show: true, count: 3 },
  latest: { show: true, count: 4 },
};

const MAX_COUNT = 12;

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

/** Clamp one block against its defaults. `minCount` is 0 for categories (0 = all)
 *  and 1 for farmers/latest — hiding a block is the toggle's job, not count 0. */
function resolveBlock(raw: unknown, def: LandingBlock, minCount: number): LandingBlock {
  const r = asRecord(raw);
  const show = typeof r.show === 'boolean' ? r.show : def.show;
  const n = Number(r.count);
  const count = Number.isInteger(n) ? Math.min(MAX_COUNT, Math.max(minCount, n)) : def.count;
  return { show, count };
}

/** Resolve stored (or incoming) landing config into a complete, clamped value.
 *  Idempotent — used on both the read (public profile) and write (save) paths.
 *  Missing / garbage → DEFAULT_LANDING. */
export function resolveLanding(raw: unknown): PublicLanding {
  const r = asRecord(raw);
  return {
    categories: resolveBlock(r.categories, DEFAULT_LANDING.categories, 0),
    farmers: resolveBlock(r.farmers, DEFAULT_LANDING.farmers, 1),
    latest: resolveBlock(r.latest, DEFAULT_LANDING.latest, 1),
  };
}
