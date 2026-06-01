'use client';

/**
 * Storefront catalog wrapper. When the farm has subcategory sections, products
 * render grouped under each section (photo + title + description); otherwise it
 * falls back to the flat catalog with category chips. Farmer attribution is
 * threaded into each card when multi-farmer mode is on (farmers non-empty).
 */
import type { PublicProduct, PublicFarmer, PublicSubcategory } from '@/lib/api';
import { CatalogClient } from './catalog-client';
import { ProductCard } from './product-card';

export function StorefrontCatalog({
  products,
  subcategories,
  farmers,
}: {
  products: PublicProduct[];
  subcategories: PublicSubcategory[];
  farmers: PublicFarmer[];
}) {
  const farmerById = new Map(farmers.map((f) => [f.id, f]));
  const farmerFor = (p: PublicProduct) => (p.farmerId ? farmerById.get(p.farmerId) : undefined);

  // No subcategory grouping → existing flat catalog with category chips.
  if (subcategories.length === 0) {
    return <CatalogClient products={products} farmers={farmers} />;
  }

  const sections = subcategories
    .map((s) => ({ subcat: s, items: products.filter((p) => p.subcategoryId === s.id) }))
    .filter((sec) => sec.items.length > 0);
  const ungrouped = products.filter(
    (p) => !p.subcategoryId || !subcategories.some((s) => s.id === p.subcategoryId),
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 48, marginTop: 28 }}>
      {sections.map(({ subcat, items }) => (
        <section key={subcat.id}>
          {subcat.imageUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={subcat.imageUrl}
              alt={subcat.name}
              style={{ width: '100%', height: 160, objectFit: 'cover', borderRadius: 14, marginBottom: 16 }}
            />
          )}
          <div className="section-head" style={{ textAlign: 'left', marginBottom: 16 }}>
            <h2 style={{ borderLeft: `4px solid ${subcat.tint ?? '#4C8A54'}`, paddingLeft: 12 }}>{subcat.name}</h2>
            {subcat.description && <p>{subcat.description}</p>}
          </div>
          <div className="grid grid--4">
            {items.map((p) => (
              <ProductCard key={p.id} product={p} farmer={farmerFor(p)} />
            ))}
          </div>
        </section>
      ))}

      {ungrouped.length > 0 && (
        <section>
          <div className="section-head" style={{ textAlign: 'left', marginBottom: 16 }}>
            <h2>Други</h2>
          </div>
          <div className="grid grid--4">
            {ungrouped.map((p) => (
              <ProductCard key={p.id} product={p} farmer={farmerFor(p)} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
