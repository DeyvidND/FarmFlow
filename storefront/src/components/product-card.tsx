'use client';

/**
 * Product card — React port of the template catalog/related card. Sources a live
 * `PublicProduct`; image falls back to the `.ph` placeholder when `imageUrl` is
 * null. Add-to-cart pushes the real `productId` + price snapshot (stotinki) into
 * the cart store and fires a toast. `withStepper` off = the leaner related card.
 *
 * `remaining` prop: when provided (not null/undefined) from an active availability
 * window, shows a stock badge on the card image. When 0 → „изчерпан" + sold-out
 * treatment (disabled button, hidden stepper). When null/undefined → no badge.
 */
import { useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import type { PublicProduct, PublicFarmer } from '@/lib/api';
import { money } from '@/lib/api';
import { coverCropStyle } from '@/lib/cover-crop';
import { useCart } from '@/lib/cart';
import { toast } from './toast';
import { QtyStepper } from './qty-stepper';
import { Cart } from './icons';

export function ProductCard({
  product,
  farmer,
  withStepper = true,
  disabled = false,
  remaining = null,
}: {
  product: PublicProduct;
  farmer?: PublicFarmer;
  withStepper?: boolean;
  disabled?: boolean;
  remaining?: number | null;
}) {
  const add = useCart((s) => s.add);
  const [qty, setQty] = useState(1);
  const href = product.slug ? `/product/${product.slug}` : undefined;

  // Merge availability sold-out state with any external `disabled` flag.
  const hasWindow = remaining !== null && remaining !== undefined;
  const soldOut = disabled || (hasWindow && remaining === 0);

  const addToCart = () => {
    add(
      {
        productId: product.id,
        name: product.name,
        priceStotinki: product.priceStotinki,
        weight: product.weight ?? undefined,
        imageUrl: product.imageUrl,
        courierDisabled: product.courierDisabled,
      },
      qty,
    );
    toast(`„${product.name}" е добавен в количката`);
  };

  // Honor the framed card shape (square→1:1, tall→4:5, wide/absent→theme default),
  // matching the chaika storefront + admin grid so framing is WYSIWYG.
  const shape = product.coverCrop?.shape;
  const phStyle = shape === 'square' || shape === 'tall'
    ? { aspectRatio: shape === 'square' ? '1 / 1' : '4 / 5' }
    : undefined;

  const thumbInner = product.imageUrl ? (
    // next/image for lazy-loading + automatic optimization. Absolutely filling the
    // `.ph` box (which is `position:relative; display:grid`) is what makes object-fit
    // crop + the saved pan/zoom take effect — an in-flow img keeps its source aspect,
    // leaving object-fit nothing to crop so the framing would appear to do nothing.
    <Image
      src={product.imageUrl}
      alt={product.name}
      width={600}
      height={600}
      sizes="(max-width: 640px) 50vw, 320px"
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', ...coverCropStyle(product.coverCrop) }}
    />
  ) : (
    <span className="ph__label">{product.name}</span>
  );

  const badgeStyle: React.CSSProperties = {
    position: 'absolute',
    bottom: 10,
    left: 10,
    zIndex: 3,
    padding: '3px 10px',
    borderRadius: 999,
    fontSize: 12,
    fontWeight: 700,
    lineHeight: 1.4,
    pointerEvents: 'none',
    color: '#fff',
  };

  return (
    <article
      className="card product"
      data-product
      style={soldOut ? { opacity: 0.72 } : undefined}
    >
      {href ? (
        <Link href={href} className="ph" style={{ ...phStyle, position: 'relative' }}>
          {thumbInner}
          {hasWindow && (
            soldOut ? (
              <span style={{ ...badgeStyle, background: '#c0392b' }}>изчерпан</span>
            ) : (
              <span style={{ ...badgeStyle, background: 'var(--color-primary, #4C8A54)' }}>{remaining} в наличност</span>
            )
          )}
        </Link>
      ) : (
        <span className="ph" style={{ ...phStyle, position: 'relative' }}>
          {thumbInner}
          {hasWindow && (
            soldOut ? (
              <span style={{ ...badgeStyle, background: '#c0392b' }}>изчерпан</span>
            ) : (
              <span style={{ ...badgeStyle, background: 'var(--color-primary, #4C8A54)' }}>{remaining} в наличност</span>
            )
          )}
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
        {farmer && (
          <div
            className="product__meta"
            style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 2 }}
          >
            <span
              style={{ width: 8, height: 8, borderRadius: 99, background: farmer.tint ?? '#4C8A54', flexShrink: 0 }}
            />
            Произведено от {farmer.name}
          </div>
        )}
        <div className="product__price">{money(product.priceStotinki)}</div>
        {product.courierDisabled && (
          <div
            className="product__meta"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              marginTop: 2,
              padding: '2px 9px',
              borderRadius: 999,
              fontSize: 12,
              fontWeight: 600,
              background: '#fdf1e3',
              color: '#9a5b13',
              alignSelf: 'flex-start',
            }}
            title="Този продукт не се изпраща с куриер — само вземане от място или местна доставка"
          >
            Само на място · без куриер
          </div>
        )}
        <div className="product__foot">
          {withStepper && !soldOut && <QtyStepper value={qty} onChange={setQty} />}
          <button
            type="button"
            className="btn btn--primary btn--sm btn--full"
            onClick={soldOut ? undefined : addToCart}
            disabled={soldOut}
            style={soldOut ? { opacity: 0.5, cursor: 'not-allowed' } : undefined}
          >
            <Cart /> {soldOut ? 'Изчерпан' : 'Добави'}
          </button>
        </div>
      </div>
    </article>
  );
}
