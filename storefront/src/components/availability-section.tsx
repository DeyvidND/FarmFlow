'use client';

/**
 * „Налично сега" — storefront section for time-bounded availability windows.
 *
 * Overlays active availability windows onto the product catalog:
 * - Shows only products that have an active window AND appear in the catalog.
 * - Displays „остават N" when remaining > 0, or „изчерпан" (sold-out) when 0.
 * - The add-to-cart button is hidden when remaining === 0.
 * - When the farm is multi-farmer (`farmers` array non-empty), groups items by
 *   farmer with a heading per farmer, mirroring the catalog grouping.
 * - Returns null when there are no matching items.
 *
 * Reuses the real `ProductCard` component (which includes its own qty stepper
 * and add-to-cart logic) for consistent UX. An overlay badge shows remaining
 * quantity or sold-out state without replacing the card's existing flow.
 */
import type { PublicProduct, PublicFarmer, PublicAvailabilityWindow } from '@/lib/api';
import { ProductCard } from './product-card';

interface AvailabilityItem {
  window: PublicAvailabilityWindow;
  product: PublicProduct;
  farmer?: PublicFarmer;
}

export function AvailabilitySection({
  title,
  products,
  windows,
  farmers = [],
}: {
  title: string;
  products: PublicProduct[];
  windows: PublicAvailabilityWindow[];
  farmers?: PublicFarmer[];
}) {
  const productById = new Map(products.map((p) => [p.id, p]));
  const farmerById = new Map(farmers.map((f) => [f.id, f]));

  const items: AvailabilityItem[] = windows.reduce<AvailabilityItem[]>((acc, w) => {
    const product = productById.get(w.productId);
    if (!product) return acc;
    const farmer = product.farmerId ? farmerById.get(product.farmerId) : undefined;
    acc.push({ window: w, product, farmer });
    return acc;
  }, []);

  if (items.length === 0) return null;

  const isMultiFarmer = farmers.length > 0;

  if (isMultiFarmer) {
    // Group by farmer — each farmer gets a heading. Items without a farmer go last.
    const byFarmer = new Map<string | null, AvailabilityItem[]>();
    for (const item of items) {
      const key = item.farmer?.id ?? null;
      const bucket = byFarmer.get(key) ?? [];
      bucket.push(item);
      byFarmer.set(key, bucket);
    }

    return (
      <section className="section--tight" data-screen-label="Availability / Налично сега">
        <div className="wrap">
          <div className="section-head center" style={{ marginBottom: 28 }}>
            <h2 style={{ marginTop: 8 }}>{title}</h2>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 40 }}>
            {[...byFarmer.entries()].map(([farmerId, farmerItems]) => {
              const farmer = farmerId ? farmerById.get(farmerId) : undefined;
              return (
                <div key={farmerId ?? 'ungrouped'}>
                  {farmer && (
                    <div
                      className="section-head"
                      style={{ textAlign: 'left', marginBottom: 16 }}
                    >
                      <h3
                        style={{
                          borderLeft: `4px solid ${farmer.tint ?? '#4C8A54'}`,
                          paddingLeft: 12,
                        }}
                      >
                        {farmer.name}
                      </h3>
                    </div>
                  )}
                  <div className="grid grid--4">
                    {farmerItems.map((item) => (
                      <AvailabilityCard key={item.product.id} item={item} />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </section>
    );
  }

  // Single-farmer / flat mode.
  return (
    <section className="section--tight" data-screen-label="Availability / Налично сега">
      <div className="wrap">
        <div className="section-head center" style={{ marginBottom: 28 }}>
          <h2 style={{ marginTop: 8 }}>{title}</h2>
        </div>
        <div className="grid grid--4">
          {items.map((item) => (
            <AvailabilityCard key={item.product.id} item={item} />
          ))}
        </div>
      </div>
    </section>
  );
}

/**
 * Wraps a `ProductCard` with an availability badge overlay (remaining / sold-out).
 * The card itself handles add-to-cart; we hide it via a wrapper when sold-out
 * and show the quantity badge via `pointer-events:none` overlay on the card.
 */
function AvailabilityCard({ item }: { item: AvailabilityItem }) {
  const { window: w, product, farmer } = item;
  const soldOut = w.remaining === 0;

  return (
    <div style={{ position: 'relative' }}>
      {/* Badge: „остават N" or „изчерпан" */}
      <div
        style={{
          position: 'absolute',
          top: 8,
          right: 8,
          zIndex: 2,
          borderRadius: 99,
          padding: '2px 10px',
          fontSize: 12,
          fontWeight: 600,
          background: soldOut ? 'var(--color-error, #c0392b)' : 'var(--color-primary, #4C8A54)',
          color: '#fff',
          pointerEvents: 'none',
        }}
      >
        {soldOut ? 'изчерпан' : `остават ${w.remaining}`}
      </div>

      {/* Sold-out overlay — dims the card and blocks interaction */}
      {soldOut && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 1,
            borderRadius: 'inherit',
            background: 'rgba(255,255,255,0.55)',
            pointerEvents: 'all',
          }}
          aria-hidden
        />
      )}

      <ProductCard product={product} farmer={farmer} withStepper={!soldOut} />
    </div>
  );
}
