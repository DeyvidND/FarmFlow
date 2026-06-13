import { cookies } from 'next/headers';
import { API_BASE, SESSION_COOKIE } from '@/lib/session';
import { StatsClient } from '@/components/stats/stats-client';
import type { StatsSummary } from '@/lib/types';

export const dynamic = 'force-dynamic';

/** Server-fetch the default (30d) window so the screen paints with data; the
 *  client refetches on any range change. Never throws — null → "couldn't load". */
async function load(): Promise<StatsSummary | null> {
  const token = cookies().get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const res = await fetch(`${API_BASE}/stats?range=30d`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  }).catch(() => null);
  if (!res || !res.ok) return null;
  return res.json();
}

export default async function StatsPage() {
  const initial = await load();
  return <StatsClient initial={initial} />;
}
