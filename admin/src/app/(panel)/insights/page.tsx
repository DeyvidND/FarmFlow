import { cookies } from 'next/headers';
import { API_BASE, SESSION_COOKIE } from '@/lib/session';
import { InsightsClient } from '@/components/insights-client';
import type { PlatformInsights, PlatformTimeseries } from '@/lib/api-client';

export const dynamic = 'force-dynamic';

async function serverFetch<T>(path: string): Promise<T | null> {
  const token = cookies().get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const res = await fetch(`${API_BASE}/${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
  if (!res.ok) return null;
  return res.json();
}

export default async function InsightsPage() {
  // Pre-fetch both the insights overview and the default 30d timeseries in
  // parallel so the chart renders immediately without a client-side spinner.
  const [data, initialSeries] = await Promise.all([
    serverFetch<PlatformInsights>('platform/insights'),
    serverFetch<PlatformTimeseries>('platform/insights/timeseries?range=30d'),
  ]);
  return <InsightsClient initial={data} initialSeries={initialSeries} />;
}
