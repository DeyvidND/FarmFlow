'use client';

/**
 * Client-side cart store (zustand + localStorage `ff_cart`), the React-state
 * port of the template's `FFCart`. Items key by real `productId` and carry a
 * snapshot of name/price so the cart renders without re-fetching; checkout
 * posts `{ productId, quantity }` and the backend re-snapshots + re-checks.
 *
 * Money is integer **stotinki** (template used floats — we keep ints).
 */
import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface CartItem {
  productId: string;
  name: string;
  priceStotinki: number;
  weight?: string;
  imageUrl?: string | null;
  qty: number;
}

interface CartState {
  items: CartItem[];
  /** Add `qty` of an item, merging into an existing line by productId. */
  add: (item: Omit<CartItem, 'qty'>, qty: number) => void;
  /** Set an absolute qty; <= 0 removes the line. */
  setQty: (productId: string, qty: number) => void;
  remove: (productId: string) => void;
  clear: () => void;
}

export const useCart = create<CartState>()(
  persist(
    (set) => ({
      items: [],
      add: (item, qty) =>
        set((s) => {
          const existing = s.items.find((it) => it.productId === item.productId);
          if (existing) {
            return {
              items: s.items.map((it) =>
                it.productId === item.productId
                  ? { ...it, qty: it.qty + qty }
                  : it,
              ),
            };
          }
          return { items: [...s.items, { ...item, qty }] };
        }),
      setQty: (productId, qty) =>
        set((s) => ({
          items:
            qty <= 0
              ? s.items.filter((it) => it.productId !== productId)
              : s.items.map((it) =>
                  it.productId === productId ? { ...it, qty } : it,
                ),
        })),
      remove: (productId) =>
        set((s) => ({ items: s.items.filter((it) => it.productId !== productId) })),
      clear: () => set({ items: [] }),
    }),
    { name: 'ff_cart', skipHydration: true },
  ),
);

/** Total item count (sum of quantities). */
export const selectCount = (s: CartState) =>
  s.items.reduce((n, it) => n + it.qty, 0);

/** Subtotal in stotinki. */
export const selectSubtotal = (s: CartState) =>
  s.items.reduce((sum, it) => sum + it.priceStotinki * it.qty, 0);

/**
 * `true` once the persisted cart has been read from localStorage. Gate any UI
 * that branches on cart contents (the cart page itself) on this, so SSR/first
 * render don't flash the empty state before rehydration. The badge can use the
 * lighter `useHasMounted` since 0 → N is not jarring.
 */
export function useCartHydrated(): boolean {
  // Start false so SSR and the first client render agree; touch the persist API
  // only inside the effect (it isn't available during server prerender).
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    const p = useCart.persist;
    const unsub = p.onFinishHydration(() => setHydrated(true));
    p.rehydrate();
    if (p.hasHydrated()) setHydrated(true);
    return unsub;
  }, []);
  return hydrated;
}
