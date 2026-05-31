import { cookies } from 'next/headers';
import { API_BASE, SESSION_COOKIE } from '@/lib/session';
import { TenantsClient } from '@/components/tenants-client';
import type { PlatformTenant } from '@/lib/api-client';

export const dynamic = 'force-dynamic';

async function getTenants(): Promise<PlatformTenant[]> {
  const token = cookies().get(SESSION_COOKIE)?.value;
  if (!token) return [];
  const res = await fetch(`${API_BASE}/platform/tenants`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
  if (!res.ok) return [];
  return res.json();
}

export default async function TenantsPage() {
  const tenants = await getTenants();
  return <TenantsClient initial={tenants} />;
}
