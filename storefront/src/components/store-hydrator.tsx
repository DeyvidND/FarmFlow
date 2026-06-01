'use client';

import { useEffect } from 'react';
import { useCart } from '@/lib/cart';

/**
 * Rehydrates the persisted cart on the client. The store uses
 * `skipHydration: true` so SSR starts empty and matches the first client render;
 * this triggers the localStorage read once, after mount. Renders nothing.
 */
export function StoreHydrator() {
  useEffect(() => {
    useCart.persist.rehydrate();
  }, []);
  return null;
}
