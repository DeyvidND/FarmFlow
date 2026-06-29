import { cookies } from 'next/headers';
import { API_BASE, SESSION_COOKIE } from '@/lib/session';
import { DeliveryAccountsClient } from '@/components/delivery-accounts-client';
import { DeliveryOpsBoard } from '@/components/delivery-ops-board';
import type { Paginated, DeliveryAccount, DeliveryOps } from '@/lib/api-client';

export const dynamic = 'force-dynamic';

const EMPTY: Paginated<DeliveryAccount> = { items: [], nextCursor: null };

async function getAccounts(token: string | undefined): Promise<Paginated<DeliveryAccount>> {
  if (!token) return EMPTY;
  const res = await fetch(`${API_BASE}/platform/delivery/accounts?limit=50`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
  if (!res.ok) return EMPTY;
  return res.json();
}

async function getOps(token: string | undefined): Promise<DeliveryOps | null> {
  if (!token) return null;
  const res = await fetch(`${API_BASE}/platform/delivery/ops`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
  if (!res.ok) return null;
  return res.json();
}

export default async function DeliveryPage() {
  const token = cookies().get(SESSION_COOKIE)?.value;
  const [initial, ops] = await Promise.all([getAccounts(token), getOps(token)]);
  return (
    <>
      {ops && <DeliveryOpsBoard ops={ops} />}
      <DeliveryAccountsClient initial={initial} />
    </>
  );
}
