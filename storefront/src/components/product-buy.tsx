'use client';

/**
 * Product-detail buy controls — qty stepper + large add-to-cart. Pushes the real
 * productId + price snapshot into the cart store and toasts.
 */
import { useState } from 'react';
import type { PublicProduct } from '@/lib/api';
import { useCart } from '@/lib/cart';
import { toast } from './toast';
import { QtyStepper } from './qty-stepper';

export function ProductBuy({ product }: { product: PublicProduct }) {
  const add = useCart((s) => s.add);
  const [qty, setQty] = useState(1);

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

  return (
    <div
      style={{
        display: 'flex',
        gap: 14,
        alignItems: 'center',
        flexWrap: 'wrap',
        marginTop: 8,
      }}
    >
      <QtyStepper value={qty} onChange={setQty} />
      <button type="button" className="btn btn--primary btn--lg" onClick={addToCart}>
        Добави в количка
      </button>
    </div>
  );
}
