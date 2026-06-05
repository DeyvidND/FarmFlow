import { cookies } from 'next/headers';
import { API_BASE, SESSION_COOKIE } from '@/lib/session';
import { PaymentsClient } from '@/components/payments/payments-client';
import { SubscriptionCard } from '@/components/payments/subscription-card';
import type { StripeSummary, BillingSummary } from '@/lib/api-client';

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

const NO_BILLING: BillingSummary = {
  enabled: false,
  plan: 'standard',
  status: 'active',
  graceUntil: null,
  hasCard: false,
  cardBrand: null,
  cardLast4: null,
  basePriceStotinki: 3000,
  emailPriceStotinki: 200,
  pushesThisCycle: 0,
  estimatedNextStotinki: 3000,
  invoices: [],
};

async function getJson<T>(path: string, fallback: T): Promise<T> {
  const token = cookies().get(SESSION_COOKIE)?.value;
  if (!token) return fallback;
  const res = await fetch(`${API_BASE}/${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  }).catch(() => null);
  if (!res || !res.ok) return fallback;
  return res.json();
}

export default async function PaymentsPage() {
  const [summary, billing] = await Promise.all([
    getJson<StripeSummary>('stripe/connect/summary', DISCONNECTED),
    getJson<BillingSummary>('billing/summary', NO_BILLING),
  ]);
  // Publishable keys are safe in the browser; empty = "not configured" state.
  const publishableKey = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? '';
  return (
    <div className="max-w-[820px]">
      <SubscriptionCard summary={billing} />
      <PaymentsClient initial={summary} publishableKey={publishableKey} />
    </div>
  );
}
