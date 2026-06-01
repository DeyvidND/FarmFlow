'use client';

/**
 * Curated bundle cards — React port of `bundles.html`. Bundles are products with
 * `category='bundle'`; each carries its contents (`bundleItems`), a struck-through
 * `compareAtPriceStotinki`, and a `featured` "★ Най-популярен" ribbon. Adds to the
 * cart as a single line (keyed by the bundle's productId).
 */
import type { PublicProduct } from '@/lib/api';
import { money } from '@/lib/api';
import { useCart } from '@/lib/cart';
import { toast } from './toast';
import { Cart, Check } from './icons';

export function BundlesClient({ bundles }: { bundles: PublicProduct[] }) {
  const add = useCart((s) => s.add);

  const addBundle = (b: PublicProduct) => {
    add(
      {
        productId: b.id,
        name: b.name,
        priceStotinki: b.priceStotinki,
        weight: b.weight ?? 'пакет',
        imageUrl: b.imageUrl,
      },
      1,
    );
    toast(`„${b.name}“ е добавен в количката`);
  };

  if (!bundles.length) {
    return (
      <p className="muted" style={{ marginTop: 28 }}>
        Няма налични пакети в момента.
      </p>
    );
  }

  return (
    <div className="grid grid--3" style={{ marginTop: 30 }}>
      {bundles.map((b) => (
        <article
          className="card"
          key={b.id}
          style={b.featured ? { borderColor: 'var(--accent)', borderWidth: 2 } : undefined}
        >
          <div className="ph" style={{ aspectRatio: '4 / 3' }}>
            {b.featured && (
              <span
                className="tag"
                style={{ position: 'absolute', top: 12, left: 12, background: 'var(--accent)', color: '#2a2110' }}
              >
                ★ Най-популярен
              </span>
            )}
            <span className="ph__label">{b.name} · 4:3</span>
          </div>
          <div style={{ padding: 22, display: 'flex', flexDirection: 'column', flex: 1 }}>
            <h3 style={{ fontSize: 23 }}>{b.name}</h3>
            {b.description && (
              <div className="muted" style={{ fontSize: 13.5, marginBottom: 14 }}>
                {b.description}
              </div>
            )}
            <ul style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 18 }}>
              {(b.bundleItems ?? []).map((line, i) => (
                <li
                  key={i}
                  style={{ display: 'flex', gap: 9, alignItems: 'flex-start', fontSize: 14.5 }}
                >
                  <span
                    style={{
                      color: 'var(--primary)',
                      flex: 'none',
                      marginTop: 3,
                      display: 'inline-flex',
                      width: 16,
                      height: 16,
                    }}
                  >
                    <Check />
                  </span>
                  {line}
                </li>
              ))}
            </ul>
            <div style={{ marginTop: 'auto' }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 14 }}>
                <span className="product__price" style={{ margin: 0 }}>
                  {money(b.priceStotinki)}
                </span>
                {b.compareAtPriceStotinki != null && (
                  <span className="muted" style={{ textDecoration: 'line-through', fontSize: 15 }}>
                    {money(b.compareAtPriceStotinki)}
                  </span>
                )}
              </div>
              <button className="btn btn--primary btn--full" type="button" onClick={() => addBundle(b)}>
                <span
                  style={{
                    display: 'inline-flex',
                    width: 18,
                    height: 18,
                    verticalAlign: 'middle',
                    marginRight: 6,
                  }}
                >
                  <Cart />
                </span>
                Добави пакета
              </button>
            </div>
          </div>
        </article>
      ))}
    </div>
  );
}
