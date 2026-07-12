import { cookies } from 'next/headers';
import { API_BASE, SESSION_COOKIE } from '@/lib/session';
import { StripeAccountsClient } from '@/components/stripe-accounts-client';
import type { PlatformStripeAccount } from '@/lib/api-client';

export const dynamic = 'force-dynamic';

async function getAccounts(): Promise<PlatformStripeAccount[]> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return [];
  const res = await fetch(`${API_BASE}/platform/stripe/accounts`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
  if (!res.ok) return [];
  return res.json();
}

export default async function StripeAccountsPage() {
  const rows = await getAccounts();
  return <StripeAccountsClient initial={rows} />;
}
