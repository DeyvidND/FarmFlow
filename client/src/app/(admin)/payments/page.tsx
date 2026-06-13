import { cookies } from 'next/headers';
import { API_BASE, SESSION_COOKIE } from '@/lib/session';
import { PaymentsClient } from '@/components/payments/payments-client';
import type { StripeSummary, CodPaymentsSummary } from '@/lib/api-client';

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
  recentPayments: [],
  feeBps: 0,
};

const NO_COD: CodPaymentsSummary = { totalStotinki: 0, count: 0, days: [] };

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

// Платформата не таксува през Stripe (без абонамент) — затова „Плащания"
// показва само свързването на фермата със Stripe за картови плащания от клиенти.
// Картата за абонамент (SubscriptionCard) е скрита нарочно; билинг кодът остава
// наличен, но не се показва.
export default async function PaymentsPage() {
  const [summary, cod] = await Promise.all([
    getJson<StripeSummary>('stripe/connect/summary', DISCONNECTED),
    getJson<CodPaymentsSummary>('orders/cod-payments', NO_COD),
  ]);
  return (
    <div className="max-w-[820px]">
      <PaymentsClient initial={summary} cod={cod} />
    </div>
  );
}
