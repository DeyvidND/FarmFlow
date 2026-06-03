/**
 * Derive helpers for the multi-farmer + subcategory storefront views. The public
 * API hands the storefront flat arrays (`PublicProduct[]`, `PublicFarmer[]`,
 * `PublicSubcategory[]`); products carry `farmerId` / `subcategoryId`. These
 * helpers reconstruct the design's relation — FARMER → SUBSECTION → PRODUCTS —
 * shared by /farmers, /farmers/[id], the catalog and the home listing.
 */
import type { PublicProduct, PublicFarmer, PublicSubcategory } from './api';

/** Products attributed to one farmer (active catalog already excludes bundles upstream). */
export function farmerProducts(products: PublicProduct[], farmerId: string): PublicProduct[] {
  return products.filter((p) => p.farmerId === farmerId);
}

/** How many products this farmer offers. */
export function farmerProductCount(products: PublicProduct[], farmerId: string): number {
  return farmerProducts(products, farmerId).length;
}

/** Distinct subcategories this farmer has products in (used for the "X категории" count). */
export function farmerSubcatCount(
  products: PublicProduct[],
  subcategories: PublicSubcategory[],
  farmerId: string,
): number {
  const ids = new Set(subcategories.map((s) => s.id));
  const present = new Set(
    farmerProducts(products, farmerId)
      .map((p) => p.subcategoryId)
      .filter((id): id is string => !!id && ids.has(id)),
  );
  return present.size;
}

/** Count of products in a subcategory across every farmer. */
export function subcategoryCount(products: PublicProduct[], subcatId: string): number {
  return products.filter((p) => p.subcategoryId === subcatId).length;
}

export interface FarmerSection {
  /** `null` for products the farmer offers that aren't in any subcategory. */
  subcat: PublicSubcategory | null;
  items: PublicProduct[];
}

/**
 * One farmer's products grouped into their subsections (subcategories), ordered
 * by the subcategory display position. Products without a (known) subcategory
 * collapse into a trailing `subcat: null` section. Empty sections are dropped.
 */
export function farmerSections(
  products: PublicProduct[],
  subcategories: PublicSubcategory[],
  farmerId: string,
): FarmerSection[] {
  const mine = farmerProducts(products, farmerId);
  const ordered = [...subcategories].sort((a, b) => a.position - b.position);

  const sections: FarmerSection[] = ordered
    .map((subcat) => ({ subcat, items: mine.filter((p) => p.subcategoryId === subcat.id) }))
    .filter((sec) => sec.items.length > 0);

  const known = new Set(subcategories.map((s) => s.id));
  const ungrouped = mine.filter((p) => !p.subcategoryId || !known.has(p.subcategoryId));
  if (ungrouped.length > 0) sections.push({ subcat: null, items: ungrouped });

  return sections;
}

/** Whole catalog grouped by subcategory (catalog view). Ungrouped → trailing `null`. */
export function catalogSections(
  products: PublicProduct[],
  subcategories: PublicSubcategory[],
): FarmerSection[] {
  const ordered = [...subcategories].sort((a, b) => a.position - b.position);
  const sections: FarmerSection[] = ordered
    .map((subcat) => ({ subcat, items: products.filter((p) => p.subcategoryId === subcat.id) }))
    .filter((sec) => sec.items.length > 0);

  const known = new Set(subcategories.map((s) => s.id));
  const ungrouped = products.filter((p) => !p.subcategoryId || !known.has(p.subcategoryId));
  if (ungrouped.length > 0) sections.push({ subcat: null, items: ungrouped });

  return sections;
}

/** "{role} · от {since}" eyebrow, gracefully dropping whichever part is missing. */
export function farmerEyebrow(f: PublicFarmer): string {
  const parts: string[] = [];
  if (f.role) parts.push(f.role);
  if (f.since) parts.push(`от ${f.since}`);
  return parts.join(' · ');
}

/** Years the farmer has been on the platform (`since` is a free-text year). */
export function farmerYears(since: string | null): number | null {
  const start = since ? parseInt(since, 10) : NaN;
  if (Number.isNaN(start)) return null;
  const years = new Date().getFullYear() - start;
  return years > 0 ? years : null;
}
