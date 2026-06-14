import { cookies } from 'next/headers';
import { API_BASE, SESSION_COOKIE } from '@/lib/session';
import { AvailabilityClient } from '@/components/availability/availability-client';
import type { Paginated, Product } from '@/lib/types';

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

export default async function AvailabilityPage() {
  const [products, tenant] = await Promise.all([
    fetchJson<Paginated<Product>>('products?limit=200', {
      items: [],
      nextCursor: null,
    }),
    fetchJson<{ availabilitySectionEnabled?: boolean; availabilityTitle?: string | null }>(
      'tenants/me',
      {},
    ),
  ]);

  return (
    <AvailabilityClient
      products={products.items}
      title={tenant.availabilityTitle ?? null}
    />
  );
}
