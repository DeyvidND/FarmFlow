import { cookies } from 'next/headers';
import { API_BASE, SESSION_COOKIE } from '@/lib/session';
import { EmailBillingClient } from '@/components/email-billing-client';
import type { PlatformEmailBilling } from '@/lib/api-client';

export const dynamic = 'force-dynamic';

async function getBilling(): Promise<PlatformEmailBilling[]> {
  const token = cookies().get(SESSION_COOKIE)?.value;
  if (!token) return [];
  const res = await fetch(`${API_BASE}/platform/email-billing`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
  if (!res.ok) return [];
  return res.json();
}

export default async function EmailBillingPage() {
  const rows = await getBilling();
  return <EmailBillingClient initial={rows} />;
}
