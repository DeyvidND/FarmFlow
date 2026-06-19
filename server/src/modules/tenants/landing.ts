/**
 * Storefront landing-page block config (settings.landing). Each of the three
 * *dynamic* home blocks — categories, farmers, latest offers — can be shown or
 * hidden and capped to N items from the admin panel. A pure leaf module (no
 * imports) so both the public-cache read path and the tenants write path can
 * share it without a circular import, mirroring `site-contact.ts`.
 */

/** Auto = show the newest/first N (count); manual = show the hand-picked ids. */
export type BlockMode = 'auto' | 'manual';

export interface LandingBlock {
  show: boolean;
  /** Auto (count) vs manual (hand-picked ids). Default 'auto'. */
  mode: BlockMode;
  /** Items shown in auto mode. For `categories`, 0 means "all"; farmers/latest >= 1. */
  count: number;
  /** Hand-picked item ids in manual mode (ordered, deduped, capped 12). */
  ids: string[];
}

/** Reviews block: a show flag + an ordered list of farmer-picked review ids. */
export interface ReviewsBlock {
  show: boolean;
  ids: string[];
}

export interface PublicLanding {
  categories: LandingBlock;
  farmers: LandingBlock;
  latest: LandingBlock;
  reviews: ReviewsBlock;
}

/** Defaults mirror the storefront's pre-config hardcoded behavior, so a tenant
 *  with no saved config renders identically: all categories, 3 farmers, 4 latest.
 *  All dynamic blocks default to `auto` (count-driven) with no manual picks.
 *  The reviews block is opt-in (off, no picks) — no reviews block until enabled. */
export const DEFAULT_LANDING: PublicLanding = {
  categories: { show: true, mode: 'auto', count: 0, ids: [] }, // 0 = all categories
  farmers: { show: true, mode: 'auto', count: 3, ids: [] },
  latest: { show: true, mode: 'auto', count: 4, ids: [] },
  reviews: { show: false, ids: [] },
};

const MAX_COUNT = 12;
const MAX_IDS = 12;

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

/** Ordered, deduped, capped list of string ids from raw input. Non-string and
 *  empty entries are dropped; order is the farmer's pick order. */
function resolveIdList(raw: unknown, max: number): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  if (Array.isArray(raw)) {
    for (const v of raw) {
      if (typeof v === 'string' && v && !seen.has(v)) {
        seen.add(v);
        ids.push(v);
        if (ids.length >= max) break;
      }
    }
  }
  return ids;
}

/** Clamp one block against its defaults. `minCount` is 0 for categories (0 = all)
 *  and 1 for farmers/latest — hiding a block is the toggle's job, not count 0. */
function resolveBlock(raw: unknown, def: LandingBlock, minCount: number): LandingBlock {
  const r = asRecord(raw);
  const show = typeof r.show === 'boolean' ? r.show : def.show;
  const mode: BlockMode = r.mode === 'manual' ? 'manual' : 'auto';
  const n = Number(r.count);
  const count = Number.isInteger(n) ? Math.min(MAX_COUNT, Math.max(minCount, n)) : def.count;
  const ids = resolveIdList(r.ids, MAX_IDS);
  return { show, mode, count, ids };
}

/** Reviews block: a show flag + an ordered, deduped, capped list of picked review
 *  ids. Non-string entries are dropped; order is the farmer's pick order. */
function resolveReviewsBlock(raw: unknown): ReviewsBlock {
  const r = asRecord(raw);
  const show = typeof r.show === 'boolean' ? r.show : DEFAULT_LANDING.reviews.show;
  return { show, ids: resolveIdList(r.ids, MAX_IDS) };
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
    reviews: resolveReviewsBlock(r.reviews),
  };
}
