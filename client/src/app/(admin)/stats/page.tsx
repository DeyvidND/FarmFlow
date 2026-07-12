import { cookies } from 'next/headers';
import { API_BASE, SESSION_COOKIE } from '@/lib/session';
import { StatsClient } from '@/components/stats/stats-client';
import type { StatsSummary } from '@/lib/types';

export const dynamic = 'force-dynamic';

async function authed<T>(path: string, token: string): Promise<T | null> {
  const res = await fetch(`${API_BASE}/${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  }).catch(() => null);
  if (!res || !res.ok) return null;
  return res.json();
}

export default async function StatsPage() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return <StatsClient initial={null} role="admin" farmers={[]} multiFarmer={false} />;

  const [initial, account, profile] = await Promise.all([
    authed<StatsSummary>('stats?range=30d', token),
    authed<{ role?: string }>('auth/me', token),
    authed<{ multiFarmer?: boolean }>('tenants/me', token),
  ]);
  const role = account?.role ?? 'admin';
  const multiFarmer = profile?.multiFarmer === true;
  // Only the owner of a multi-farmer shop needs the producer picker.
  const farmers =
    role === 'admin' && multiFarmer
      ? (await authed<{ id: string; name: string }[]>('farmers', token)) ?? []
      : [];

  return (
    <StatsClient initial={initial} role={role} farmers={farmers} multiFarmer={multiFarmer} />
  );
}
