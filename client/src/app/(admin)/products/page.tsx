import { cookies } from 'next/headers';
import { API_BASE, SESSION_COOKIE } from '@/lib/session';
import { ProductsClient } from '@/components/products/products-client';
import type { AvailabilityWindow, Farmer, Paginated, Product, Subcategory } from '@/lib/types';

export const dynamic = 'force-dynamic';

async function fetchJson<T>(path: string, fallback: T): Promise<T> {
  const token = cookies().get(SESSION_COOKIE)?.value;
  if (!token) return fallback;
  const res = await fetch(`${API_BASE}/${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
  if (!res.ok) return fallback;
  return res.json();
}

export default async function ProductsPage() {
  // auth/me is independent of all other calls. Fold it into a single parallel
  // batch with the data fetches. The farmers endpoint is included unconditionally
  // so producers and admins both resolve in one round-trip; the server scopes the
  // list by role — the owner gets the whole tenant, a producer gets just their own
  // row (so their own `courierEnabled` is known to the courier toggles below).
  const [me, products, farmers, subcats, tenant, windows] = await Promise.all([
    fetchJson<{ role?: string }>('auth/me', {}),
    // The server scopes this list to the producer's own products for role='farmer'.
    fetchJson<Paginated<Product>>('products?limit=50', { items: [], nextCursor: null }),
    // Producer → just their own row; owner → all farmers. Powers the courier toggles.
    fetchJson<Farmer[]>('farmers', []),
    fetchJson<Subcategory[]>('subcategories', []),
    fetchJson<{
      multiFarmer: boolean;
      multiSubcat: boolean;
      productOfWeekEnabled?: boolean;
      productOfWeekMode?: 'manual' | 'auto';
      productOfWeekId?: string | null;
      productOfWeekNote?: string | null;
    }>('tenants/me', { multiFarmer: false, multiSubcat: false }),
    // Stock now lives in «Задай наличност» — map productId → remaining for the card pills.
    fetchJson<AvailabilityWindow[]>('availability-windows', []),
  ]);
  const isFarmer = me.role === 'farmer';

  const availability: Record<string, number> = {};
  for (const w of windows) {
    if (w.productId) availability[w.productId] = Math.max(availability[w.productId] ?? 0, w.remaining);
  }

  return (
    <ProductsClient
      initial={products}
      availability={availability}
      farmers={farmers}
      subcats={subcats}
      // Producers never pick a farmer (it's always themselves) and don't control the
      // shop-wide «Продукт на седмицата» or the storefront catalog order.
      multiFarmer={isFarmer ? false : tenant.multiFarmer}
      multiSubcat={tenant.multiSubcat}
      potwEnabled={isFarmer ? false : (tenant.productOfWeekEnabled ?? false)}
      potwMode={tenant.productOfWeekMode ?? 'manual'}
      featuredId={tenant.productOfWeekId ?? null}
      potwNote={tenant.productOfWeekNote ?? ''}
      role={isFarmer ? 'farmer' : 'admin'}
    />
  );
}
