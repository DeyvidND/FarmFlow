import { cookies } from 'next/headers';
import { API_BASE, SESSION_COOKIE } from '@/lib/session';
import { AvailabilityClient } from '@/components/availability/availability-client';
import type { AvailabilityWindow } from '@/lib/types';

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
  hasVariants: boolean;
};

export default async function AvailabilityPage() {
  // auth/me, the products picker, tenants/me, and the farmers list are all
  // independent — fetch in a single parallel batch. For producers the farmers
  // endpoint returns an empty array scoped by the tenant, so the unconditional
  // call is safe and eliminates the serial auth/me round-trip.
  const [me, products, tenant, farmers, windows] = await Promise.all([
    fetchJson<{ role?: string; farmerId?: string | null }>('auth/me', {}),
    // Scoped picker endpoint — owner gets all active products, producer gets only theirs.
    fetchJson<PickerProduct[]>('availability-windows/products', []),
    fetchJson<{ multiFarmer?: boolean }>('tenants/me', {}),
    // Farmers list only needed for the owner farmer-filter dropdown.
    fetchJson<{ id: string; name: string }[]>('farmers', []),
    // Server-render the windows so the client doesn't fetch + flash on load.
    fetchJson<AvailabilityWindow[]>('availability-windows', []),
  ]);
  const role = (me.role ?? 'admin') as 'admin' | 'farmer';

  const multiFarmer = tenant.multiFarmer === true;

  return (
    <AvailabilityClient
      products={products}
      initialWindows={windows}
      role={role}
      farmers={multiFarmer ? farmers : []}
      multiFarmer={multiFarmer}
    />
  );
}
