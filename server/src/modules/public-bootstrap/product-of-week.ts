import { isoWeekNumber } from '../../common/util/iso-week';

/** The resolved storefront highlight: a product id plus its optional blurb. */
export interface ProductOfWeek {
  id: string;
  note: string | null;
}

/** The tenant fields that drive the «Продукт на седмицата» highlight. */
export interface ProductOfWeekConfig {
  productOfWeekEnabled?: boolean | null;
  productOfWeekMode?: string | null;
  productOfWeekId?: string | null;
  productOfWeekNote?: string | null;
}

/**
 * Resolve the featured product for a storefront from the tenant config + the
 * public (active) product list:
 *  - gate off, or no products → `null`
 *  - mode 'auto' → ISO-week rotation over the active products (deterministic, no cron)
 *  - mode 'manual' → the picked product if it's still active, else `null`
 * `now` is injected so callers/tests control the clock.
 */
export function resolveProductOfWeek(
  t: ProductOfWeekConfig,
  products: { id: string }[],
  now: Date,
): ProductOfWeek | null {
  if (!t.productOfWeekEnabled || products.length === 0) return null;

  if (t.productOfWeekMode === 'auto') {
    const idx = isoWeekNumber(now) % products.length;
    return { id: products[idx].id, note: t.productOfWeekNote ?? null };
  }

  if (t.productOfWeekId && products.some((p) => p.id === t.productOfWeekId)) {
    return { id: t.productOfWeekId, note: t.productOfWeekNote ?? null };
  }
  return null;
}
