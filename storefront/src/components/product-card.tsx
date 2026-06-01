'use client';

/**
 * Product card — React port of the template catalog/related card. Sources a live
 * `PublicProduct`; image falls back to the `.ph` placeholder when `imageUrl` is
 * null. Add-to-cart pushes the real `productId` + price snapshot (stotinki) into
 * the cart store and fires a toast. `withStepper` off = the leaner related card.
 */
import { useState } from 'react';
import Link from 'next/link';
import type { PublicProduct } from '@/lib/api';
import { money } from '@/lib/api';
import { useCart } from '@/lib/cart';
import { toast } from './toast';
import { QtyStepper } from './qty-stepper';
import { Cart } from './icons';

export function ProductCard({
  product,
  withStepper = true,
}: {
  product: PublicProduct;
  withStepper?: boolean;
}) {
  const add = useCart((s) => s.add);
  const [qty, setQty] = useState(1);
  const href = product.slug ? `/product/${product.slug}` : undefined;

  const addToCart = () => {
    add(
      {
        productId: product.id,
        name: product.name,
        priceStotinki: product.priceStotinki,
        weight: product.weight ?? undefined,
        imageUrl: product.imageUrl,
      },
      qty,
    );
    toast(`„${product.name}“ е добавен в количката`);
  };

  const thumbInner = product.imageUrl ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={product.imageUrl}
      alt={product.name}
      style={{ width: '100%', height: '100%', objectFit: 'cover' }}
    />
  ) : (
    <span className="ph__label">{product.name}</span>
  );

  return (
    <article className="card product" data-product>
      {href ? (
        <Link href={href} className="ph" style={{ display: 'block' }}>
          {thumbInner}
        </Link>
      ) : (
        <span className="ph" style={{ display: 'block' }}>
          {thumbInner}
        </span>
      )}

      <div className="product__body">
        {href ? (
          <Link href={href}>
            <h3 className="product__name">{product.name}</h3>
          </Link>
        ) : (
          <h3 className="product__name">{product.name}</h3>
        )}
        {product.weight && <div className="product__meta">{product.weight}</div>}
        <div className="product__price">{money(product.priceStotinki)}</div>
        <div className="product__foot">
          {withStepper && <QtyStepper value={qty} onChange={setQty} />}
          <button
            type="button"
            className="btn btn--primary btn--sm btn--full"
            onClick={addToCart}
          >
            <Cart /> Добави
          </button>
        </div>
      </div>
    </article>
  );
}
