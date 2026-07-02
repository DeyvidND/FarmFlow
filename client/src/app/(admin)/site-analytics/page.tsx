import { cookies } from 'next/headers';
import { API_BASE, SESSION_COOKIE } from '@/lib/session';
import { AnalyticsClient } from '@/components/analytics/analytics-client';
import type { AnalyticsSummary } from '@/lib/types';

export const dynamic = 'force-dynamic';

async function authed<T>(path: string, token: string): Promise<T | null> {
  const res = await fetch(`${API_BASE}/${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  }).catch(() => null);
  if (!res || !res.ok) return null;
  return res.json();
}

export default async function SiteAnalyticsPage() {
  const token = cookies().get(SESSION_COOKIE)?.value;
  if (!token) return <AnalyticsClient initial={null} role="admin" />;

  const [initial, account] = await Promise.all([
    authed<AnalyticsSummary>('analytics?range=30d', token),
    authed<{ role?: string }>('auth/me', token),
  ]);
  return <AnalyticsClient initial={initial} role={account?.role ?? 'admin'} />;
}
