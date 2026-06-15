import { cookies } from 'next/headers';
import { API_BASE, SESSION_COOKIE } from '@/lib/session';
import { ProductsClient } from '@/components/products/products-client';
import type { Farmer, Paginated, Product, Subcategory } from '@/lib/types';

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
  const me = await fetchJson<{ role?: string }>('auth/me', {});
  const isFarmer = me.role === 'farmer';

  const [products, farmers, subcats, tenant] = await Promise.all([
    // The server scopes this list to the producer's own products for role='farmer'.
    fetchJson<Paginated<Product>>('products?limit=50', { items: [], nextCursor: null }),
    // A producer manages only their own products — the farmer column/filter is moot.
    isFarmer ? Promise.resolve([] as Farmer[]) : fetchJson<Farmer[]>('farmers', []),
    fetchJson<Subcategory[]>('subcategories', []),
    fetchJson<{
      multiFarmer: boolean;
      multiSubcat: boolean;
      productOfWeekEnabled?: boolean;
      productOfWeekMode?: 'manual' | 'auto';
      productOfWeekId?: string | null;
    }>('tenants/me', { multiFarmer: false, multiSubcat: false }),
  ]);
  return (
    <ProductsClient
      initial={products}
      farmers={farmers}
      subcats={subcats}
      // Producers never pick a farmer (it's always themselves) and don't control the
      // shop-wide «Продукт на седмицата» or the storefront catalog order.
      multiFarmer={isFarmer ? false : tenant.multiFarmer}
      multiSubcat={tenant.multiSubcat}
      potwEnabled={isFarmer ? false : (tenant.productOfWeekEnabled ?? false)}
      potwMode={tenant.productOfWeekMode ?? 'manual'}
      featuredId={tenant.productOfWeekId ?? null}
      role={isFarmer ? 'farmer' : 'admin'}
    />
  );
}
