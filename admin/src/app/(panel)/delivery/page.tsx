import { cookies } from 'next/headers';
import { API_BASE, SESSION_COOKIE } from '@/lib/session';
import { DeliveryAccountsClient } from '@/components/delivery-accounts-client';
import type { Paginated, DeliveryAccount } from '@/lib/api-client';

export const dynamic = 'force-dynamic';

const EMPTY: Paginated<DeliveryAccount> = { items: [], nextCursor: null };

async function getAccounts(): Promise<Paginated<DeliveryAccount>> {
  const token = cookies().get(SESSION_COOKIE)?.value;
  if (!token) return EMPTY;
  const res = await fetch(`${API_BASE}/platform/delivery/accounts?limit=50`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
  if (!res.ok) return EMPTY;
  return res.json();
}

export default async function DeliveryPage() {
  const initial = await getAccounts();
  return <DeliveryAccountsClient initial={initial} />;
}
