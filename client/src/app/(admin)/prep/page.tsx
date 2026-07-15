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

// «Подготовка» — merged Производство + Утре. One farmer, one day (default tomorrow),
// two axes. Scope rule mirrors /tomorrow: single-farmer shop auto-scopes; multi-farmer
// owner defaults to the first producer and can switch client-side.
export default async function PrepPage(props: { searchParams: Promise<{ date?: string }> }) {
  const searchParams = await props.searchParams;
  const date = searchParams.date;

  const [account, profile] = await Promise.all([
    getJson<{ role?: string }>('auth/me', {}),
    getJson<{ multiFarmer?: boolean }>('tenants/me', {}),
  ]);
  const role = account.role === 'farmer' ? 'farmer' : account.role === 'driver' ? 'driver' : 'admin';
  const multiFarmer = profile.multiFarmer === true;

  const farmers = role === 'admin' ? await getJson<{ id: string; name: string }[]>('farmers', []) : [];
  const defaultFarmerId = role === 'admin' ? (farmers[0]?.id ?? '') : '';

  const empty: PrepSummary = { date: date ?? '', confirmedOrders: 0, pendingOrders: 0, orders: [] };
  // A driver has no farmerId at all — the server resolves their own route leg
  // from the JWT instead, same as a farmer resolving their own farmerId.
  const canFetch = role === 'farmer' || role === 'driver' || defaultFarmerId !== '';
  const qs = new URLSearchParams();
  if (date) qs.set('date', date);
  if (defaultFarmerId) qs.set('farmerId', defaultFarmerId);
  const q = qs.toString();
  const initial = canFetch
    ? await getJson<PrepSummary>(`orders/prep${q ? `?${q}` : ''}`, empty)
    : empty;

  return (
    <div className="max-w-[1100px]">
      <PrepClient
        initial={initial}
        initialDate={initial.date}
        role={role}
        farmers={farmers}
        multiFarmer={multiFarmer}
        defaultFarmerId={defaultFarmerId}
      />
    </div>
  );
}
