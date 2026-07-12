import { cookies } from 'next/headers';
import { API_BASE, SESSION_COOKIE } from '@/lib/session';
import { TomorrowClient } from '@/components/tomorrow/tomorrow-client';
import type { TomorrowOrder } from '@/lib/api-client';

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

// Task #14 — «Утре»: tomorrow's confirmed orders + self-tracked prep state, so
// the farmer knows what to prepare and whom to call about a gap. GET
// /orders/tomorrow has no tenant-wide variant (mirrors /orders/mine) — an owner
// MUST scope to one producer. Single-farmer shop → auto-scope to that sole
// farmer (invisible to the owner); multi-farmer shop → default to the first
// producer, switchable client-side (mirrors Плащания/Статистика's picker).
export default async function TomorrowPage() {
  const [account, profile] = await Promise.all([
    getJson<{ role?: string }>('auth/me', {}),
    getJson<{ multiFarmer?: boolean }>('tenants/me', {}),
  ]);
  const role = account.role === 'farmer' ? 'farmer' : 'admin';
  const multiFarmer = profile.multiFarmer === true;

  const farmers =
    role === 'admin' ? await getJson<{ id: string; name: string }[]>('farmers', []) : [];
  const defaultFarmerId = role === 'admin' ? (farmers[0]?.id ?? '') : '';

  const canFetch = role === 'farmer' || defaultFarmerId !== '';
  const initial = canFetch
    ? await getJson<TomorrowOrder[]>(
        `orders/tomorrow${defaultFarmerId ? `?farmerId=${defaultFarmerId}` : ''}`,
        [],
      )
    : [];

  return (
    <div className="max-w-[980px]">
      <TomorrowClient
        initial={initial}
        role={role}
        farmers={farmers}
        multiFarmer={multiFarmer}
        defaultFarmerId={defaultFarmerId}
      />
    </div>
  );
}
