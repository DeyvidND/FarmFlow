'use client';

/**
 * Home featured listing with the layout toggle — React port of the home.html
 * segmented control (Продукти / Събсекции / Двете). The choice persists in
 * localStorage (`ff_home_list`). The seg only appears when the farm groups
 * products into subsections; otherwise it's the plain featured strip.
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { PublicProduct, PublicSubcategory } from '@/lib/api';
import { ProductCard } from './product-card';
import { CategoryCard } from './category-card';

type Mode = 'products' | 'subs' | 'both';
const MODES: { mode: Mode; label: string }[] = [
  { mode: 'products', label: 'Продукти' },
  { mode: 'subs', label: 'Събсекции' },
  { mode: 'both', label: 'Двете' },
];

export function HomeListing({
  featured,
  categories,
}: {
  featured: PublicProduct[];
  categories: { subcat: PublicSubcategory; count: number }[];
}) {
  const hasSubs = categories.length > 0;
  const [mode, setMode] = useState<Mode>('products');

  // Hydrate the saved choice after mount (avoids SSR/localStorage mismatch).
  useEffect(() => {
    if (!hasSubs) return;
    const saved = localStorage.getItem('ff_home_list') as Mode | null;
    if (saved === 'products' || saved === 'subs' || saved === 'both') setMode(saved);
  }, [hasSubs]);

  const choose = (m: Mode) => {
    setMode(m);
    try {
      localStorage.setItem('ff_home_list', m);
    } catch {
      /* private mode — non-fatal */
    }
  };

  const showProducts = !hasSubs || mode !== 'subs';
  const showSubs = hasSubs && mode !== 'products';

  return (
    <section className="section--tight" data-screen-label="Home / Listing">
      <div className="wrap">
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-end',
            justifyContent: 'space-between',
            gap: 20,
            marginBottom: 26,
            flexWrap: 'wrap',
          }}
        >
          <div className="section-head" style={{ margin: 0 }}>
            <span className="eyebrow">Любими на сезона</span>
            <h2 style={{ marginTop: 8 }}>Свежо набрани днес</h2>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
            {hasSubs && (
              <div className="seg" role="tablist" aria-label="Какво да се листне на началната">
                {MODES.map((m) => (
                  <button
                    key={m.mode}
                    type="button"
                    role="tab"
                    aria-selected={mode === m.mode}
                    className={mode === m.mode ? 'is-active' : ''}
                    onClick={() => choose(m.mode)}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            )}
            <Link href="/products" className="btn btn--soft">
              Виж всички
            </Link>
          </div>
        </div>

        {/* products */}
        <div className="home-block" hidden={!showProducts}>
          <div className="grid grid--4">
            {featured.map((p) => (
              <ProductCard key={p.id} product={p} withStepper={false} />
            ))}
          </div>
        </div>

        {/* subsections / categories */}
        {hasSubs && (
          <div className="home-block" hidden={!showSubs}>
            <div className="section-head" style={{ margin: '6px 0 18px' }}>
              <span className="eyebrow">Пазарувай по събсекция</span>
              <h3 style={{ fontSize: 'clamp(22px,3vw,30px)', marginTop: 6 }}>Категории продукти</h3>
            </div>
            <div className="grid grid--2">
              {categories.map(({ subcat, count }) => (
                <CategoryCard key={subcat.id} subcat={subcat} count={count} />
              ))}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
