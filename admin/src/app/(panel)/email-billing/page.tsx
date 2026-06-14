import { cookies } from 'next/headers';
import { API_BASE, SESSION_COOKIE } from '@/lib/session';
import { EmailBillingClient } from '@/components/email-billing-client';
import type { PlatformEmailBilling } from '@/lib/api-client';

export const dynamic = 'force-dynamic';

const EMPTY: PlatformEmailBilling = {
  rows: [],
  totals: { recipientTotal: 0, revenueStotinki: 0, costStotinki: 0, marginStotinki: 0 },
};

async function getBilling(): Promise<PlatformEmailBilling> {
  const token = cookies().get(SESSION_COOKIE)?.value;
  if (!token) return EMPTY;
  const res = await fetch(`${API_BASE}/platform/email-billing`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
  if (!res.ok) return EMPTY;
  return res.json();
}

export default async function EmailBillingPage() {
  const data = await getBilling();
  return <EmailBillingClient initial={data} />;
}
