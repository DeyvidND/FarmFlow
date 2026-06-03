import { cookies } from 'next/headers';
import { API_BASE, SESSION_COOKIE } from '@/lib/session';
import { RouteClient } from '@/components/route/route-client';
import { bgDateLabel } from '@/lib/utils';
import type { RouteResult } from '@/lib/types';

export const dynamic = 'force-dynamic';

type EndMode = 'home' | 'last' | 'custom';
type OrderMode = 'slots' | 'distance';

/** Today's date in Bulgaria local time (matches the API's day grouping). */
function bgToday(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Sofia',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

async function getRoute(date: string, end?: EndMode, order?: OrderMode): Promise<RouteResult> {
  const empty: RouteResult = {
    date,
    origin: { address: null, lat: null, lng: null },
    stops: [],
    end: { mode: 'home', address: null, lat: null, lng: null },
    orderMode: 'slots',
    totalDistanceM: null,
    totalDurationS: null,
    optimized: false,
  };
  const token = cookies().get(SESSION_COOKIE)?.value;
  if (!token) return empty;
  const qs = `date=${date}${end ? `&end=${end}` : ''}${order ? `&order=${order}` : ''}`;
  const res = await fetch(`${API_BASE}/orders/route?${qs}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
  if (!res.ok) return empty;
  return res.json();
}

export default async function RoutePage({
  searchParams,
}: {
  searchParams: { date?: string; end?: string; order?: string };
}) {
  const date = searchParams.date ?? bgToday();
  const end =
    searchParams.end === 'home' || searchParams.end === 'last' || searchParams.end === 'custom'
      ? (searchParams.end as EndMode)
      : undefined;
  const order = searchParams.order === 'distance' ? 'distance' : undefined;
  const route = await getRoute(date, end, order);
  const dateLabel = bgDateLabel(new Date(`${date}T00:00:00`)).replace(' г.', '');
  return <RouteClient route={route} dateLabel={dateLabel} />;
}
