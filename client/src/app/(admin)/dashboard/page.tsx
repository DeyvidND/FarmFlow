import { cookies } from 'next/headers';
import { API_BASE, SESSION_COOKIE } from '@/lib/session';
import { DashboardClient } from '@/components/dashboard/dashboard-client';
import type { StoreReadiness } from '@/components/dashboard/store-readiness-card';
import type { DashboardSummary, DeliveryConfig, Order } from '@/lib/types';
import type { BillingSummary } from '@/lib/api-client';

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

/** Show the "add a card" nudge only when billing is live, the farm is on the
 *  standard plan, has no card on file, and isn't already suspended (the suspended
 *  banner covers that case). Never throws — no nudge on any failure. */
async function shouldNudgeCard(): Promise<boolean> {
  const token = cookies().get(SESSION_COOKIE)?.value;
  if (!token) return false;
  const res = await fetch(`${API_BASE}/billing/summary`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  }).catch(() => null);
  if (!res || !res.ok) return false;
  const b: BillingSummary = await res.json();
  return b.enabled && b.plan === 'standard' && !b.hasCard && b.status !== 'inactive';
}

/** Store-readiness signals for the first-run checklist — all derived from data
 *  the owner already controls. Any fetch failure just leaves a step unchecked. */
async function loadReadiness(): Promise<{ readiness: StoreReadiness; deliveryEnabled: boolean }> {
  const fallback: StoreReadiness = { hasProducts: false, hasPayment: false, hasDelivery: false, hasContact: false };
  const token = cookies().get(SESSION_COOKIE)?.value;
  if (!token) return { readiness: fallback, deliveryEnabled: false };
  const headers = { Authorization: `Bearer ${token}` };
  const j = async <T,>(path: string, fb: T): Promise<T> => {
    const r = await fetch(`${API_BASE}/${path}`, { headers, cache: 'no-store' }).catch(() => null);
    return r && r.ok ? ((await r.json()) as T) : fb;
  };
  const [opts, tenant, contactRes] = await Promise.all([
    j<unknown[]>('products/options', []),
    j<{ delivery: DeliveryConfig | null; deliveryEnabled?: boolean }>('tenants/me', { delivery: null }),
    j<{ contact: { phone?: string; address?: string } }>('tenants/me/site-contact', { contact: {} }),
  ]);
  const m = tenant.delivery?.methods;
  return {
    readiness: {
      hasProducts: (opts?.length ?? 0) > 0,
      hasPayment: !!(tenant.delivery?.cod?.enabled || tenant.delivery?.card?.enabled),
      hasDelivery: !!(m?.pickup?.enabled || m?.ownSlots?.enabled || m?.econtOffice?.enabled || m?.econtAddress?.enabled),
      hasContact: !!(contactRes.contact?.phone || contactRes.contact?.address),
    },
    deliveryEnabled: !!tenant.deliveryEnabled,
  };
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: { date?: string };
}) {
  const date = searchParams.date ?? new Date().toISOString().slice(0, 10);
  const [{ summary, orders }, nudgeCard, { readiness, deliveryEnabled }] = await Promise.all([
    load(date),
    shouldNudgeCard(),
    loadReadiness(),
  ]);
  return (
    <DashboardClient
      summary={summary}
      initialOrders={orders}
      nudgeCard={nudgeCard}
      readiness={readiness}
      deliveryEnabled={deliveryEnabled}
    />
  );
}
