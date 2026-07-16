import { cookies } from 'next/headers';
import { API_BASE, SESSION_COOKIE } from '@/lib/session';
import { MyTurnoverClient } from '@/components/turnover/my-turnover-client';
import type { MultiRouteResult } from '@/lib/types';

export const dynamic = 'force-dynamic';

/** Today's date in Bulgaria local time (matches the API's day grouping). */
function bgToday(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Sofia',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/**
 * «Моят оборот» — a courier's personal turnover for one day. Reuses the
 * driver-scoped GET /orders/route (which already filters to the caller's own
 * leg and carries each leg's summed money), so no dedicated backend is needed:
 * the courier's leg money IS their turnover. `routes` empty ⇒ not on a route
 * that day (the client shows the „не участваш" empty state).
 */
async function fetchRoute(date: string): Promise<MultiRouteResult> {
  const empty: MultiRouteResult = {
    date,
    origin: { address: null, lat: null, lng: null },
    end: { mode: 'home', address: null, lat: null, lng: null },
    couriers: 0,
    routes: [],
  };
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return empty;
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/orders/route?date=${date}`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
    });
  } catch {
    return empty;
  }
  if (!res.ok) return empty;
  return res.json();
}

export default async function MyTurnoverPage(props: {
  searchParams: Promise<{ date?: string }>;
}) {
  const { date } = await props.searchParams;
  const day = date || bgToday();
  const initial = await fetchRoute(day);
  return (
    <div className="max-w-[720px]">
      <MyTurnoverClient initial={initial} initialDate={day} />
    </div>
  );
}
