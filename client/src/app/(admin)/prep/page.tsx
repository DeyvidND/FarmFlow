import { cookies } from 'next/headers';
import { API_BASE, SESSION_COOKIE } from '@/lib/session';
import { PrepClient } from '@/components/prep/prep-client';
import type { PrepSummary } from '@/lib/api-client';

export const dynamic = 'force-dynamic';

async function getJson<T>(path: string, fallback: T): Promise<T> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return fallback;
  const res = await fetch(`${API_BASE}/${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  }).catch(() => null);
  if (!res || !res.ok) return fallback;
  return res.json();
}

// «Подготовка» — merged Производство + Утре. One day (default: the nearest day
// with orders, ±2 of tomorrow), two axes. Scope rule mirrors /tomorrow: a
// single-farmer shop auto-scopes; a multi-farmer owner now lands on «Всички»
// (all producers) and can switch client-side.
export default async function PrepPage(props: { searchParams: Promise<{ date?: string }> }) {
  const searchParams = await props.searchParams;
  const explicitDate = searchParams.date;

  const [account, profile] = await Promise.all([
    getJson<{ role?: string }>('auth/me', {}),
    getJson<{ multiFarmer?: boolean }>('tenants/me', {}),
  ]);
  const role = account.role === 'farmer' ? 'farmer' : account.role === 'driver' ? 'driver' : 'admin';
  const multiFarmer = profile.multiFarmer === true;

  const farmers = role === 'admin' ? await getJson<{ id: string; name: string }[]>('farmers', []) : [];
  const firstFarmerId = role === 'admin' ? (farmers[0]?.id ?? '') : '';
  const showPicker = role === 'admin' && multiFarmer && farmers.length > 1;
  // Owner with a multi-producer picker defaults to «Всички»; a single-producer
  // shop (or one-producer owner) stays scoped to that producer.
  const initialFarmerId = showPicker ? 'all' : firstFarmerId;
  // A driver has no farmerId at all — the server resolves their own route leg
  // from the JWT instead, same as a farmer resolving their own farmerId.
  const canFetch = role === 'farmer' || role === 'driver' || firstFarmerId !== '';

  // Resolve the day server-side (no empty-day flash): an explicit ?date wins;
  // otherwise ask the API for the best default — tomorrow, or the nearest day
  // within ±2 that actually has orders. Scope the probe to what we'll show
  // («Всички» = tenant-wide, no farmerId). Failure → let prep fall back to its
  // own tomorrow default.
  let day = explicitDate;
  if (!day && canFetch) {
    const probeQs = initialFarmerId && initialFarmerId !== 'all' ? `?farmerId=${initialFarmerId}` : '';
    const dd = await getJson<{ date: string }>(`orders/prep/default-day${probeQs}`, { date: '' });
    day = dd.date || undefined;
  }

  const empty: PrepSummary = { date: day ?? '', confirmedOrders: 0, pendingOrders: 0, orders: [] };
  const loadFor = (farmerId?: string) => {
    const qs = new URLSearchParams();
    if (day) qs.set('date', day);
    if (farmerId) qs.set('farmerId', farmerId);
    const q = qs.toString();
    return getJson<PrepSummary>(`orders/prep${q ? `?${q}` : ''}`, empty);
  };

  let initial: PrepSummary;
  if (!canFetch) {
    initial = empty;
  } else if (initialFarmerId === 'all') {
    // «Всички»: ONE tenant-wide call (no farmerId) — the backend already returns
    // one TomorrowOrder per (order, farmer) slice, exactly what PrepClient's own
    // «Всички» branch expects, so the first render matches and no client
    // refetch (or flash) is needed. No more N-per-farmer fan-out/flatten.
    initial = await loadFor();
  } else {
    initial = await loadFor(initialFarmerId || undefined);
  }

  return (
    <div className="max-w-[1100px]">
      <PrepClient
        initial={initial}
        initialDate={initial.date}
        role={role}
        farmers={farmers}
        multiFarmer={multiFarmer}
        defaultFarmerId={initialFarmerId}
      />
    </div>
  );
}
