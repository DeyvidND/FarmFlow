import { cookies } from 'next/headers';
import { API_BASE, SESSION_COOKIE } from '@/lib/session';
import { MyReportClient } from '@/components/my-report/my-report-client';
import type { CommissionSummary } from '@/lib/api-client';

export const dynamic = 'force-dynamic';

const EMPTY_SUMMARY: CommissionSummary = {
  commissionEnabled: false,
  defaultRateBps: 0,
  farmers: [],
  totalGrossStotinki: 0,
  totalCommissionStotinki: 0,
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

// Дремещ модул (Task 10): производителят вижда собствения си оборот от пазара
// и — ако собственикът е включил комисионата — дължимата сума. Скоупнато на
// сървъра по токена му (backend филтрира по farmerId), не по клиентска логика.
export default async function MyReportPage() {
  const summary = await getJson<CommissionSummary>('vendor-finance/commission/summary', EMPTY_SUMMARY);
  return <MyReportClient summary={summary} />;
}
