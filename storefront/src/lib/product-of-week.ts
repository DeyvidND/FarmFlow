import type { PublicProduct, StorefrontProfile } from './api';

/** ISO-8601 week number (1..53), UTC. Mirrors the backend's iso-week util so the
 *  auto-rotate pick lands on the same product. */
export function isoWeekNumber(date: Date): number {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}

/**
 * Resolve the «Продукт на седмицата» from the storefront profile + the (active,
 * position-ordered) product list:
 *  - gate off / empty list → null
 *  - 'auto' → weekly ISO-week rotation
 *  - 'manual' → the picked product if still present, else null
 */
export function resolveProductOfWeek(
  profile: Pick<
    StorefrontProfile,
    'productOfWeekEnabled' | 'productOfWeekMode' | 'productOfWeekId'
  > | null,
  products: PublicProduct[],
  now: Date,
): PublicProduct | null {
  if (!profile?.productOfWeekEnabled || products.length === 0) return null;
  if (profile.productOfWeekMode === 'auto') {
    return products[isoWeekNumber(now) % products.length] ?? null;
  }
  if (profile.productOfWeekId) {
    return products.find((p) => p.id === profile.productOfWeekId) ?? null;
  }
  return null;
}
