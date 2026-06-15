'use client';

/**
 * Product-detail buy controls — qty stepper + large add-to-cart. Pushes the real
 * productId + price snapshot into the cart store and toasts.
 *
 * `remaining` prop: when provided from an active availability window, shows a
 * stock badge above the buy controls. When 0 → sold-out treatment (disabled).
 */
import { useState } from 'react';
import type { PublicProduct } from '@/lib/api';
import { useCart } from '@/lib/cart';
import { toast } from './toast';
import { QtyStepper } from './qty-stepper';

export function ProductBuy({
  product,
  remaining = null,
}: {
  product: PublicProduct;
  remaining?: number | null;
}) {
  const add = useCart((s) => s.add);
  const [qty, setQty] = useState(1);

  const hasWindow = remaining !== null && remaining !== undefined;
  const soldOut = hasWindow && remaining === 0;

  const addToCart = () => {
    if (soldOut) return;
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
    toast(`„${product.name}" е добавен в количката`);
  };

  const badgePill: React.CSSProperties = {
    display: 'inline-block',
    padding: '4px 14px',
    borderRadius: 999,
    fontSize: 13,
    fontWeight: 700,
    color: '#fff',
    marginBottom: 14,
  };

  return (
    <>
      {hasWindow && (
        soldOut ? (
          <span style={{ ...badgePill, background: '#c0392b' }}>изчерпан</span>
        ) : (
          <span style={{ ...badgePill, background: 'var(--color-primary, #4C8A54)' }}>
            {remaining} в наличност
          </span>
        )
      )}
      <div
        style={{
          display: 'flex',
          gap: 14,
          alignItems: 'center',
          flexWrap: 'wrap',
          marginTop: 8,
        }}
      >
        {!soldOut && <QtyStepper value={qty} onChange={setQty} />}
        <button
          type="button"
          className="btn btn--primary btn--lg"
          onClick={addToCart}
          disabled={soldOut}
          style={soldOut ? { opacity: 0.5, cursor: 'not-allowed' } : undefined}
        >
          {soldOut ? 'Изчерпан' : 'Добави в количка'}
        </button>
      </div>
    </>
  );
}
