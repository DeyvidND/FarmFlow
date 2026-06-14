import { cookies } from 'next/headers';
import { API_BASE, SESSION_COOKIE } from '@/lib/session';
import { PaymentsClient } from '@/components/payments/payments-client';
import type { StripeSummary, PaymentsSummary } from '@/lib/api-client';

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

const NO_PAYMENTS: PaymentsSummary = {
  totalStotinki: 0,
  count: 0,
  codTotalStotinki: 0,
  codCount: 0,
  cardTotalStotinki: 0,
  cardCount: 0,
  orders: [],
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

// Платформата не таксува през Stripe (без абонамент) — затова „Плащания"
// показва парите от поръчки (наложен платеж + карта) и свързването на фермата
// със Stripe за картови плащания. Картата за абонамент (SubscriptionCard) е
// скрита нарочно; билинг кодът остава наличен, но не се показва.
export default async function PaymentsPage() {
  const [summary, payments] = await Promise.all([
    getJson<StripeSummary>('stripe/connect/summary', DISCONNECTED),
    getJson<PaymentsSummary>('orders/payments', NO_PAYMENTS),
  ]);
  return (
    <div className="max-w-[980px]">
      <PaymentsClient stripe={summary} payments={payments} />
    </div>
  );
}
