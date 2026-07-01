'use client';

/**
 * Catalog grid + category chips — React port of `products.html` (the `data-tabs`
 * behavior becomes a state filter). Receives the live catalog from the server
 * page; chips are built from the categories actually present.
 */
import { useMemo, useState } from 'react';
import type { PublicProduct, PublicFarmer } from '@/lib/api';
import { buildCategoryTabs, productInTab } from '@/lib/categories';
import { ProductCard } from './product-card';

export function CatalogClient({
  products,
  farmers = [],
  availMap = new Map(),
}: {
  products: PublicProduct[];
  farmers?: PublicFarmer[];
  availMap?: Map<string, number>;
}) {
  const tabs = useMemo(() => buildCategoryTabs(products), [products]);
  const farmerById = useMemo(() => new Map(farmers.map((f) => [f.id, f])), [farmers]);
  const [active, setActive] = useState('all');
  const [courierOnly, setCourierOnly] = useState(false);

  // A product is courier-available when its farmer has a courier connected AND
  // the product itself isn't flagged as pickup-only.
  const isCourierAvailable = (p: PublicProduct) => {
    const farmer = p.farmerId ? farmerById.get(p.farmerId) : undefined;
    return (farmer?.courierReady ?? false) && !(p.courierDisabled ?? false);
  };

  // Any products with courier → show the filter chip
  const hasCourierProducts = useMemo(
    () => products.some(isCourierAvailable),
    [products, farmerById],
  );

  const inTab = products.filter((p) => productInTab(p, active));
  const shown = courierOnly ? inTab.filter(isCourierAvailable) : inTab;
  // The courier filter emptied an otherwise non-empty category — say so and offer
  // a way back, instead of the generic "category has nothing" message.
  const emptiedByCourierFilter = courierOnly && shown.length === 0 && inTab.length > 0;

  return (
    <>
      <div
        className="chips-row"
        style={{ display: 'flex', gap: 10, flexWrap: 'wrap', margin: '28px 0 26px' }}
      >
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            className={`chip${active === t.key ? ' is-active' : ''}`}
            aria-selected={active === t.key}
            onClick={() => setActive(t.key)}
          >
            {t.label}
          </button>
        ))}
        {hasCourierProducts && (
          <button
            type="button"
            className={`chip${courierOnly ? ' is-active' : ''}`}
            aria-selected={courierOnly}
            onClick={() => setCourierOnly((v) => !v)}
            style={courierOnly ? {} : { borderColor: '#4C8A54', color: '#4C8A54' }}
          >
            📦 С куриер
          </button>
        )}
      </div>

      {shown.length === 0 ? (
        emptiedByCourierFilter ? (
          <p className="muted">
            Няма продукти с куриер в тази категория.{' '}
            <button
              type="button"
              onClick={() => setCourierOnly(false)}
              style={{ textDecoration: 'underline', color: 'inherit', font: 'inherit', cursor: 'pointer' }}
            >
              Изчисти филтъра
            </button>
          </p>
        ) : (
          <p className="muted">Няма продукти в тази категория.</p>
        )
      ) : (
        <div className="grid grid--4">
          {shown.map((p) => (
            <ProductCard
              key={p.id}
              product={p}
              farmer={p.farmerId ? farmerById.get(p.farmerId) : undefined}
              remaining={availMap.has(p.id) ? (availMap.get(p.id) ?? null) : null}
            />
          ))}
        </div>
      )}
    </>
  );
}
