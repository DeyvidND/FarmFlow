import { cookies } from 'next/headers';
import { API_BASE, SESSION_COOKIE } from '@/lib/session';
import { DashboardClient } from '@/components/dashboard-client';
import type { Paginated, PlatformTenant, PlatformInsights, ProblemsResponse } from '@/lib/api-client';

export const dynamic = 'force-dynamic';

async function serverFetch<T>(path: string, fallback: T): Promise<T> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return fallback;
  const res = await fetch(`${API_BASE}/${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
  if (!res.ok) return fallback;
  return res.json().catch(() => fallback);
}

export default async function DashboardPage() {
  // Platform-total farms is a small set (tens) — a single 200-row page covers the
  // whole roster, so the access/demo counts are exact (not a truncated page).
  const [tenants, insights, problems] = await Promise.all([
    serverFetch<Paginated<PlatformTenant>>('platform/tenants?limit=200', { items: [], nextCursor: null }),
    serverFetch<PlatformInsights | null>('platform/insights', null),
    serverFetch<ProblemsResponse | null>('platform/problems', null),
  ]);
  return <DashboardClient tenants={tenants.items} insights={insights} problems={problems} />;
}
