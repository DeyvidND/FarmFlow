/**
 * Category normalizer for the storefront chips. The admin stores free-text
 * Bulgarian categories (`Плодове`, `Преработени`); the catalog also gains
 * `bundle` (S3). This maps each to a stable key + display label and builds the
 * chip row from the categories actually present in the live catalog — so the
 * filter always matches real data (the template's hardcoded fruit/syrup/jam
 * chips can't be reconstructed from `Преработени` alone).
 */
import type { PublicProduct } from './api';

export interface CategoryMeta {
  key: string;
  label: string;
  order: number;
}

const KNOWN: Record<string, CategoryMeta> = {
  Плодове: { key: 'fruit', label: 'Пресни плодове', order: 1 },
  Преработени: { key: 'processed', label: 'Преработени', order: 2 },
  bundle: { key: 'bundle', label: 'Сезонни пакети', order: 3 },
};

/** Canonical meta for a product's raw category (unknown → label = raw value). */
export function categoryMeta(category: string | null | undefined): CategoryMeta {
  if (!category) return { key: 'other', label: 'Други', order: 98 };
  return KNOWN[category] ?? { key: category.toLowerCase(), label: category, order: 99 };
}

export interface CategoryTab {
  key: string;
  label: string;
}

/** "Всички" + one tab per distinct category present, ordered. */
export function buildCategoryTabs(products: PublicProduct[]): CategoryTab[] {
  const byKey = new Map<string, CategoryMeta>();
  for (const p of products) {
    const meta = categoryMeta(p.category);
    if (!byKey.has(meta.key)) byKey.set(meta.key, meta);
  }
  const tabs = [...byKey.values()]
    .sort((a, b) => a.order - b.order || a.label.localeCompare(b.label, 'bg'))
    .map((m) => ({ key: m.key, label: m.label }));
  return [{ key: 'all', label: 'Всички' }, ...tabs];
}

/** Does a product belong under the given chip key? */
export function productInTab(product: PublicProduct, tabKey: string): boolean {
  return tabKey === 'all' || categoryMeta(product.category).key === tabKey;
}
