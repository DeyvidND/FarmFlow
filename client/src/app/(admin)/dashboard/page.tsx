import { cookies } from 'next/headers';
import { API_BASE, SESSION_COOKIE } from '@/lib/session';
import { DashboardClient } from '@/components/dashboard/dashboard-client';
import type { DashboardSummary, Order } from '@/lib/types';

export const dynamic = 'force-dynamic';

const EMPTY: DashboardSummary = {
  date: '',
  orderCount: 0,
  orderDelta: 0,
  revenueStotinki: 0,
  pendingCount: 0,
  nextSlot: null,
  slots: [],
  subscriptionActive: true,
};

async function load(date: string): Promise<{ summary: DashboardSummary; orders: Order[] }> {
  const token = cookies().get(SESSION_COOKIE)?.value;
  if (!token) return { summary: { ...EMPTY, date }, orders: [] };
  const headers = { Authorization: `Bearer ${token}` };
  const [sRes, oRes] = await Promise.all([
    fetch(`${API_BASE}/dashboard?date=${date}`, { headers, cache: 'no-store' }),
    // Newest-first + capped: today's orders (the feed) always sit on the first page.
    fetch(`${API_BASE}/orders?limit=100`, { headers, cache: 'no-store' }),
  ]);
  const summary = sRes.ok ? await sRes.json() : { ...EMPTY, date };
  const orders = oRes.ok ? ((await oRes.json()).items ?? []) : [];
  return { summary, orders };
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: { date?: string };
}) {
  const date = searchParams.date ?? new Date().toISOString().slice(0, 10);
  const { summary, orders } = await load(date);
  return <DashboardClient summary={summary} initialOrders={orders} />;
}
