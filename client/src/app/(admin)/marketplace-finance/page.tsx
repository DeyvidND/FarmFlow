import { cookies } from 'next/headers';
import { API_BASE, SESSION_COOKIE } from '@/lib/session';
import { MarketplaceFinanceClient } from '@/components/marketplace-finance/marketplace-finance-client';
import type { CommissionSummary, VendorCharge } from '@/lib/api-client';

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

// Дремещ модул (Task 9): собственик на многопроизводителски пазар вижда комисиона
// по производители и месечните такси, които им начислява — не се плаща тук, само
// се води кой колко дължи (собственикът си събира парите извън системата).
export default async function MarketplaceFinancePage() {
  const [summary, charges] = await Promise.all([
    getJson<CommissionSummary>('vendor-finance/commission/summary', EMPTY_SUMMARY),
    getJson<VendorCharge[]>('vendor-finance/subscriptions', []),
  ]);
  return <MarketplaceFinanceClient initialSummary={summary} initialCharges={charges} />;
}
