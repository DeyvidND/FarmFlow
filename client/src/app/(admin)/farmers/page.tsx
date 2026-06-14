import { cookies } from 'next/headers';
import { API_BASE, SESSION_COOKIE } from '@/lib/session';
import { FarmersClient } from '@/components/farmers/farmers-client';
import type { Farmer, ProductOption, FarmerAccess } from '@/lib/types';

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

export default async function FarmersPage() {
  const [farmers, products, tenant, accessMap] = await Promise.all([
    fetchJson<Farmer[]>('farmers', []),
    fetchJson<ProductOption[]>('products/options', []),
    fetchJson<{ multiFarmer: boolean }>('tenants/me', { multiFarmer: false }),
    fetchJson<Record<string, FarmerAccess>>('farmers/access', {}),
  ]);
  return (
    <FarmersClient
      initialFarmers={farmers}
      products={products}
      initialMultiFarmer={tenant.multiFarmer}
      initialAccess={accessMap}
    />
  );
}
