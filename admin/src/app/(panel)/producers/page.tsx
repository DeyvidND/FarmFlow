import { cookies } from 'next/headers';
import { API_BASE, SESSION_COOKIE } from '@/lib/session';
import { ProducersClient } from '@/components/producers-client';
import type { Paginated, GlobalFarmer } from '@/lib/api-client';

export const dynamic = 'force-dynamic';

const EMPTY: Paginated<GlobalFarmer> = { items: [], nextCursor: null };

async function getFarmers(): Promise<Paginated<GlobalFarmer>> {
  const token = cookies().get(SESSION_COOKIE)?.value;
  if (!token) return EMPTY;
  const res = await fetch(`${API_BASE}/platform/farmers?limit=50`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
  if (!res.ok) return EMPTY;
  return res.json();
}

export default async function ProducersPage() {
  const initial = await getFarmers();
  return <ProducersClient initial={initial} />;
}
