import { cookies } from 'next/headers';
import { API_BASE, SESSION_COOKIE } from '@/lib/session';
import { ProductsClient } from '@/components/products/products-client';
import type { Farmer, Product, Subcategory } from '@/lib/types';

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
  const [products, farmers, subcats, tenant] = await Promise.all([
    fetchJson<Product[]>('products', []),
    fetchJson<Farmer[]>('farmers', []),
    fetchJson<Subcategory[]>('subcategories', []),
    fetchJson<{ multiFarmer: boolean; multiSubcat: boolean }>('tenants/me', {
      multiFarmer: false,
      multiSubcat: false,
    }),
  ]);
  return (
    <ProductsClient
      initial={products}
      farmers={farmers}
      subcats={subcats}
      multiFarmer={tenant.multiFarmer}
      multiSubcat={tenant.multiSubcat}
    />
  );
}
