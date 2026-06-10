import Link from 'next/link';
import Image from 'next/image';
import type { PublicProduct } from '@/lib/api';
import { money } from '@/lib/api';

/**
 * «Продукт на седмицата» home highlight — a prominent banner for the featured
 * product (manual pick or weekly auto-rotation, resolved upstream). Server
 * component; the CTA links to the product page (add-to-cart lives there).
 */
export function ProductOfWeekHighlight({
  product,
  note,
}: {
  product: PublicProduct;
  note?: string | null;
}) {
  const href = product.slug ? `/product/${product.slug}` : '/products';
  return (
    <section className="section" style={{ background: 'var(--surface-2)' }}>
      <div className="wrap">
        <div className="hero-grid" style={{ alignItems: 'center' }}>
          <Link href={href} className="ph ph--rounded" style={{ display: 'block', aspectRatio: '4 / 3' }}>
            {product.imageUrl ? (
              <Image
                src={product.imageUrl}
                alt={product.name}
                width={720}
                height={540}
                sizes="(max-width: 860px) 100vw, 480px"
                style={{ width: '100%', height: '100%', objectFit: 'cover' }}
              />
            ) : (
              <span className="ph__label">{product.name}</span>
            )}
          </Link>
          <div>
            <span className="eyebrow">★ Продукт на седмицата</span>
            <h2 style={{ marginTop: 10 }}>{product.name}</h2>
            {note && (
              <p className="lead" style={{ marginTop: 14, maxWidth: '44ch' }}>
                {note}
              </p>
            )}
            <div className="product__price" style={{ fontSize: 30, marginTop: 16 }}>
              {money(product.priceStotinki)}
            </div>
            <div className="cta-row" style={{ marginTop: 20 }}>
              <Link href={href} className="btn btn--primary btn--lg">
                Виж продукта
              </Link>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
