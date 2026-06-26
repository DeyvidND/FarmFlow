/** Pure promotional-pricing math. No DB, no ambient clock — callers pass `now`
 *  so the same logic drives both the public catalog and order intake, and tests
 *  are deterministic. Money is integer stotinki. */

/** A promo is live when a percentage is set AND it has no end date or the end
 *  date is still in the future. */
export function isPromoActive(
  salePercent: number | null,
  saleEndsAt: Date | null,
  now: Date,
): boolean {
  if (salePercent == null) return false;
  if (saleEndsAt == null) return true;
  return saleEndsAt.getTime() > now.getTime();
}

/** Discounted price = round(price * (1 - pct/100)). Assumes an active promo. */
export function salePriceStotinki(priceStotinki: number, salePercent: number): number {
  return Math.round((priceStotinki * (100 - salePercent)) / 100);
}

/** The price actually charged: the discounted price when the promo is active,
 *  otherwise the regular price. */
export function effectivePriceStotinki(
  priceStotinki: number,
  salePercent: number | null,
  saleEndsAt: Date | null,
  now: Date,
): number {
  return isPromoActive(salePercent, saleEndsAt, now) && salePercent != null
    ? salePriceStotinki(priceStotinki, salePercent)
    : priceStotinki;
}
