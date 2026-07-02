import { cookies } from 'next/headers';
import { API_BASE, SESSION_COOKIE } from '@/lib/session';
import { OrdersClient, ORDERS_PAGE_SIZE } from '@/components/orders/orders-client';
import type { Order, Paged } from '@/lib/types';

export const dynamic = 'force-dynamic';

const EMPTY: Paged<Order> = { items: [], total: 0 };

// First numbered page, server-rendered. Search / filter / page changes are fetched
// on demand by the client (server-side now — it no longer drains every page).
// `ok: false` means the SSR fetch itself failed (missing token, non-2xx, network
// blip on the server→API hop) — NOT that the tenant genuinely has zero orders.
// The client must not treat that as trustworthy and needs to refetch itself,
// otherwise a transient server-side hiccup permanently shows «no orders».
async function getOrders(): Promise<Paged<Order> & { ok: boolean }> {
  const token = cookies().get(SESSION_COOKIE)?.value;
  if (!token) return { ...EMPTY, ok: false };
  try {
    const res = await fetch(`${API_BASE}/orders?page=1&limit=${ORDERS_PAGE_SIZE}`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
    });
    if (!res.ok) return { ...EMPTY, ok: false };
    const data = (await res.json()) as Paged<Order>;
    return { ...data, ok: true };
  } catch {
    return { ...EMPTY, ok: false };
  }
}

export default async function OrdersPage() {
  const { ok, ...initial } = await getOrders();
  return <OrdersClient initial={initial} initialOk={ok} />;
}
