import { cookies } from 'next/headers';
import { API_BASE, SESSION_COOKIE } from '@/lib/session';
import { AvailabilityClient } from '@/components/availability/availability-client';

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

/** Lean product shape returned by the availability picker endpoint. */
export type PickerProduct = {
  id: string;
  name: string;
  weight: string | null;
  farmerId: string | null;
};

export default async function AvailabilityPage() {
  const me = await fetchJson<{ role?: string; farmerId?: string | null }>(
    'auth/me',
    {},
  );
  const role = (me.role ?? 'admin') as 'admin' | 'farmer';

  const [products, tenant, farmers] = await Promise.all([
    // Scoped picker endpoint — owner gets all active products, producer gets only theirs.
    fetchJson<PickerProduct[]>('availability-windows/products', []),
    fetchJson<{ multiFarmer?: boolean }>('tenants/me', {}),
    // Farmers list only needed for the owner farmer-filter dropdown.
    role === 'admin'
      ? fetchJson<{ id: string; name: string }[]>('farmers', [])
      : Promise.resolve([]),
  ]);

  const multiFarmer = tenant.multiFarmer === true;

  return (
    <AvailabilityClient
      products={products}
      role={role}
      farmers={multiFarmer ? farmers : []}
      multiFarmer={multiFarmer}
    />
  );
}
