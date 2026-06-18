import { cookies } from 'next/headers';
import { API_BASE, SESSION_COOKIE } from '@/lib/session';
import { PrepList } from '@/components/production/prep-list';
import { bgDateLabel } from '@/lib/utils';
import type { ProductionSummary } from '@/lib/types';

export const dynamic = 'force-dynamic';

async function getProduction(date: string): Promise<ProductionSummary> {
  const empty: ProductionSummary = { date, confirmedOrders: 0, pendingOrders: 0, multiFarmer: false, items: [] };
  const token = cookies().get(SESSION_COOKIE)?.value;
  if (!token) return empty;
  const res = await fetch(`${API_BASE}/orders/production?date=${date}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
  if (!res.ok) return empty;
  return res.json();
}

export default async function ProductionPage({
  searchParams,
}: {
  searchParams: { date?: string };
}) {
  const date = searchParams.date ?? new Date().toISOString().slice(0, 10);
  const summary = await getProduction(date);
  const dateLabel = bgDateLabel(new Date(`${date}T00:00:00`)).replace(' г.', '');
  // key by date → fresh tick state when the farmer switches days
  return <PrepList key={date} summary={summary} dateLabel={dateLabel} date={date} />;
}
