import { cookies } from 'next/headers';
import { API_BASE, SESSION_COOKIE } from '@/lib/session';
import TodayClient from '@/components/today/today-client';
import type { StoreReadiness } from '@/components/dashboard/store-readiness-card';
import type { DeliveryConfig, Order, TodaySummary } from '@/lib/types';
import { todayIso } from '@/lib/utils';

export const dynamic = 'force-dynamic';

/** Zeroed cockpit — the graceful fallback when a fetch fails or the session is
 *  missing, so the „Днес" home always renders instead of throwing. */
const EMPTY: TodaySummary = {
  date: '',
  pipeline: { new: 0, confirmed: 0, preparing: 0, outForDelivery: 0, delivered: 0, cancelled: 0, total: 0 },
  prep: { ordersToPrep: 0, fulfilled: 0 },
  route: { stops: 0, delivered: 0, pending: 0, couriers: 0 },
  protocols: { total: 0, signed: 0, pending: 0 },
  cod: { toCollectStotinki: 0, toCollectCount: 0, collectedStotinki: 0, collectedCount: 0 },
  revenueStotinki: 0,
  slots: [],
};

/** Fetch the day's cockpit summary + its orders feed in one round-trip. Never
 *  throws — any failure degrades to the zeroed summary / empty feed. */
async function load(date: string): Promise<{ summary: TodaySummary; orders: Order[] }> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return { summary: { ...EMPTY, date }, orders: [] };
  const headers = { Authorization: `Bearer ${token}` };
  try {
    const [sRes, oRes] = await Promise.all([
      fetch(`${API_BASE}/dashboard/today?date=${date}`, { headers, cache: 'no-store' }),
      // Today's orders (the feed), capped — the day filter keeps the page small.
      fetch(`${API_BASE}/orders?date=${date}&limit=100`, { headers, cache: 'no-store' }),
    ]);
    const summary = sRes.ok ? await sRes.json() : { ...EMPTY, date };
    const orders = oRes.ok ? ((await oRes.json()).items ?? []) : [];
    return { summary, orders };
  } catch {
    return { summary: { ...EMPTY, date }, orders: [] };
  }
}

/** Store-readiness signals for the first-run checklist — all derived from data
 *  the owner already controls. Any fetch failure just leaves a step unchecked. */
async function loadReadiness(): Promise<{ readiness: StoreReadiness; deliveryEnabled: boolean }> {
  const fallback: StoreReadiness = { hasProducts: false, hasPayment: false, hasDelivery: false, hasContact: false };
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
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

export default async function DashboardPage(
  props: {
    searchParams: Promise<{ date?: string }>;
  }
) {
  const searchParams = await props.searchParams;
  const date = searchParams.date ?? todayIso();
  const [{ summary, orders }, { readiness, deliveryEnabled }] = await Promise.all([
    load(date),
    loadReadiness(),
  ]);
  return (
    <TodayClient
      summary={summary}
      orders={orders}
      date={date}
      readiness={readiness}
      deliveryEnabled={deliveryEnabled}
    />
  );
}
