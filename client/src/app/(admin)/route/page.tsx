import { cookies } from 'next/headers';
import { API_BASE, SESSION_COOKIE } from '@/lib/session';
import { RouteClient } from '@/components/route/route-client';
import { bgDateLabel } from '@/lib/utils';
import type { RouteResult } from '@/lib/types';

export const dynamic = 'force-dynamic';

async function getRoute(date: string): Promise<RouteResult> {
  const empty: RouteResult = {
    date,
    origin: { address: null, lat: null, lng: null },
    stops: [],
    totalDistanceM: null,
    totalDurationS: null,
    optimized: false,
  };
  const token = cookies().get(SESSION_COOKIE)?.value;
  if (!token) return empty;
  const res = await fetch(`${API_BASE}/orders/route?date=${date}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
  if (!res.ok) return empty;
  return res.json();
}

export default async function RoutePage({ searchParams }: { searchParams: { date?: string } }) {
  const date = searchParams.date ?? new Date().toISOString().slice(0, 10);
  const route = await getRoute(date);
  const dateLabel = bgDateLabel(new Date(`${date}T00:00:00`)).replace(' г.', '');
  return <RouteClient route={route} dateLabel={dateLabel} />;
}
