import { cookies } from 'next/headers';
import { API_BASE, SESSION_COOKIE } from '@/lib/session';
import { SubcategoriesClient } from '@/components/subcategories/subcategories-client';
import type { Subcategory, ProductOption, Farmer } from '@/lib/types';

export const dynamic = 'force-dynamic';

async function fetchJson<T>(path: string, fallback: T): Promise<T> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return fallback;
  const res = await fetch(`${API_BASE}/${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
  if (!res.ok) return fallback;
  return res.json();
}

export default async function SubcategoriesPage() {
  const [subcats, products, farmers, tenant] = await Promise.all([
    fetchJson<Subcategory[]>('subcategories', []),
    fetchJson<ProductOption[]>('products/options', []),
    fetchJson<Farmer[]>('farmers', []),
    fetchJson<{ multiSubcat: boolean }>('tenants/me', { multiSubcat: false }),
  ]);
  return (
    <SubcategoriesClient
      initialSubcats={subcats}
      products={products}
      farmers={farmers.map((f) => ({ id: f.id, name: f.name }))}
      initialMultiSubcat={tenant.multiSubcat}
    />
  );
}
