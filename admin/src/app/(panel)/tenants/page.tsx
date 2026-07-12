import { cookies } from 'next/headers';
import { API_BASE, SESSION_COOKIE } from '@/lib/session';
import { TenantsClient } from '@/components/tenants-client';
import type { Paginated, PlatformTenant } from '@/lib/api-client';

export const dynamic = 'force-dynamic';

const EMPTY: Paginated<PlatformTenant> = { items: [], nextCursor: null };

async function getTenants(): Promise<Paginated<PlatformTenant>> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return EMPTY;
  const res = await fetch(`${API_BASE}/platform/tenants?limit=50`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
  if (!res.ok) return EMPTY;
  return res.json();
}

export default async function TenantsPage() {
  const initial = await getTenants();
  return <TenantsClient initial={initial} />;
}
