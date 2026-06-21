import { cookies } from 'next/headers';
import { API_BASE, SESSION_COOKIE } from '@/lib/session';
import { PaymentsClient } from '@/components/payments/payments-client';
import type { StripeSummary, PaymentsPage } from '@/lib/api-client';

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

const EMPTY_PAGE: PaymentsPage = {
  totals: {
    totalStotinki: 0,
    count: 0,
    allCount: 0,
    codTotalStotinki: 0,
    codCount: 0,
    cardTotalStotinki: 0,
    cardCount: 0,
  },
  orders: [],
  nextCursor: null,
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
// със Stripe за картови плащания. Първата страница на „Всичко" се SSR-ва за бърз
// първоначален изглед; табовете/търсенето/„зареди още" дофетчват клиентски.
export default async function PaymentsPage() {
  // Role decides both the subtitle and whether to fetch the Stripe summary.
  // A producer (role='farmer') never sees the Card tab, so skip the stripe
  // fetch entirely to avoid a pointless (and potentially 4xx) call.
  // auth/me and tenants/me are independent — fetch in parallel, then branch.
  const [account, profile] = await Promise.all([
    getJson<{ role?: string }>('auth/me', {}),
    getJson<{ multiFarmer?: boolean }>('tenants/me', {}),
  ]);
  const role = account.role === 'farmer' ? 'farmer' : 'admin';
  const multiFarmer = profile.multiFarmer === true;

  // Only the owner of a multi-farmer shop needs the producer picker (mirrors Статистика).
  const [summary, initial, farmers] = await Promise.all([
    role === 'farmer'
      ? Promise.resolve(DISCONNECTED)
      : getJson<StripeSummary>('stripe/connect/summary', DISCONNECTED),
    getJson<PaymentsPage>('orders/payments', EMPTY_PAGE),
    role === 'admin' && multiFarmer
      ? getJson<{ id: string; name: string }[]>('farmers', [])
      : Promise.resolve([] as { id: string; name: string }[]),
  ]);

  return (
    <div className="max-w-[980px]">
      <PaymentsClient
        stripe={summary}
        initial={initial}
        role={role}
        farmers={farmers}
        multiFarmer={multiFarmer}
      />
    </div>
  );
}
