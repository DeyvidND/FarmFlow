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

async function getRoute(
  date: string,
  end?: EndMode,
  order?: OrderMode,
): Promise<{ route: RouteResult; failed: boolean }> {
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
  if (!token) return { route: empty, failed: false };
  const qs = `date=${date}${end ? `&end=${end}` : ''}${order ? `&order=${order}` : ''}`;
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/orders/route?${qs}`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
    });
  } catch {
    // API unreachable — surface it, don't fake an empty route.
    return { route: empty, failed: true };
  }
  // 401/403 → handled by the auth layer (login redirect); treat as no-data, not
  // an error banner. Any other non-OK (esp. 5xx) is a real failure that must NOT
  // be silently shown as "0 stops" — a farmer would think the day is empty and
  // skip real deliveries.
  if (res.status === 401 || res.status === 403) return { route: empty, failed: false };
  if (!res.ok) return { route: empty, failed: true };
  return { route: await res.json(), failed: false };
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
  const { route, failed } = await getRoute(date, end, order);
  const dateLabel = bgDateLabel(new Date(`${date}T00:00:00`)).replace(' г.', '');
  // Maps browser key. Read at REQUEST time (force-dynamic) so it can come from the
  // runtime Dokploy env (GOOGLE_MAPS_KEY) instead of being baked at build time —
  // NEXT_PUBLIC_ vars are inlined by `next build` and can't be set at runtime, so a
  // server read + prop is the only way Dokploy can supply it. Falls back to the
  // build-time NEXT_PUBLIC_ var if that's how it's configured.
  const mapsKey = process.env.GOOGLE_MAPS_KEY ?? process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? '';
  return <RouteClient route={route} dateLabel={dateLabel} loadError={failed} mapsKey={mapsKey} />;
}
