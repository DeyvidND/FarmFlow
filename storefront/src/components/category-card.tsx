/**
 * Subcategory (subsection) card — React port of `categoryCard` (farms.js). Links
 * to the catalog section anchor (`/products#<id>`), shows an icon, the name,
 * description and a live product count. Server component.
 */
import Link from 'next/link';
import type { PublicSubcategory } from '@/lib/api';
import { Leaf } from './icons';

export function CategoryCard({
  subcat,
  count,
}: {
  subcat: PublicSubcategory;
  count: number;
}) {
  return (
    <Link href={`/products#${subcat.id}`} className="card category-card">
      <span className="category-card__ic" style={subcat.tint ? { color: subcat.tint } : undefined}>
        <Leaf />
      </span>
      <div>
        <h3 className="category-card__name">{subcat.name}</h3>
        {subcat.description && <p className="category-card__desc">{subcat.description}</p>}
      </div>
      <span className="category-card__count">{count} продукта</span>
    </Link>
  );
}
