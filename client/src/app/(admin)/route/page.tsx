import { cookies } from 'next/headers';
import { API_BASE, SESSION_COOKIE } from '@/lib/session';
import { RouteClient } from '@/components/route/route-client';
import { bgDateLabel } from '@/lib/utils';
import type { MultiRouteResult } from '@/lib/types';

export const dynamic = 'force-dynamic';

type EndMode = 'home' | 'last' | 'custom';

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
  couriers?: number,
  ends?: string,
): Promise<{ route: MultiRouteResult; failed: boolean }> {
  const empty: MultiRouteResult = {
    date,
    origin: { address: null, lat: null, lng: null },
    end: { mode: 'home', address: null, lat: null, lng: null },
    couriers: 1,
    routes: [],
  };
  const token = cookies().get(SESSION_COOKIE)?.value;
  if (!token) return { route: empty, failed: false };
  const qs =
    `date=${date}` +
    (end ? `&end=${end}` : '') +
    (couriers ? `&couriers=${couriers}` : '') +
    (ends ? `&ends=${encodeURIComponent(ends)}` : '');
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
  searchParams: { date?: string; end?: string; couriers?: string; ends?: string };
}) {
  const date = searchParams.date ?? bgToday();
  const end =
    searchParams.end === 'home' || searchParams.end === 'last' || searchParams.end === 'custom'
      ? (searchParams.end as EndMode)
      : undefined;
  const couriers = searchParams.couriers ? Math.min(10, Math.max(1, parseInt(searchParams.couriers, 10) || 1)) : undefined;
  const ends =
    typeof searchParams.ends === 'string' && searchParams.ends.trim() ? searchParams.ends : undefined;
  const { route, failed } = await getRoute(date, end, couriers, ends);
  const dateLabel = bgDateLabel(new Date(`${date}T00:00:00`)).replace(' г.', '');
  // ONE Google Maps key for the whole route screen — the map (Maps JavaScript API)
  // and the address autocomplete (Places API New). Read at REQUEST time (the page is
  // force-dynamic) from the runtime env so Dokploy can supply it without a rebuild;
  // build-time NEXT_PUBLIC_ is the fallback. The key needs both APIs enabled.
  const mapsKey = process.env.GOOGLE_MAPS_API_KEY ?? process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? '';
  return (
    <RouteClient
      route={route}
      dateLabel={dateLabel}
      loadError={failed}
      mapsKey={mapsKey}
      placesKey={mapsKey}
    />
  );
}
