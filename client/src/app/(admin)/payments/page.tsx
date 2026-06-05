import { cookies } from 'next/headers';
import { API_BASE, SESSION_COOKIE } from '@/lib/session';
import { PaymentsClient } from '@/components/payments/payments-client';
import type { StripeSummary } from '@/lib/api-client';

export const dynamic = 'force-dynamic';

const DISCONNECTED: StripeSummary = {
  enabled: false,
  connected: false,
  chargesEnabled: false,
  payoutsEnabled: false,
  detailsSubmitted: false,
  availableStotinki: 0,
  pendingStotinki: 0,
  nextPayout: null,
  feeBps: 0,
};

async function getSummary(): Promise<StripeSummary> {
  const token = cookies().get(SESSION_COOKIE)?.value;
  if (!token) return DISCONNECTED;
  const res = await fetch(`${API_BASE}/stripe/connect/summary`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  }).catch(() => null);
  if (!res || !res.ok) return DISCONNECTED;
  return res.json();
}

export default async function PaymentsPage() {
  const summary = await getSummary();
  // Publishable keys are safe in the browser; empty = "not configured" state.
  const publishableKey = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? '';
  return <PaymentsClient initial={summary} publishableKey={publishableKey} />;
}
