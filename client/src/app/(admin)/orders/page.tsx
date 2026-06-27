import { cookies } from 'next/headers';
import { API_BASE, SESSION_COOKIE } from '@/lib/session';
import { OrdersClient, ORDERS_PAGE_SIZE } from '@/components/orders/orders-client';
import type { Order, Paged } from '@/lib/types';

export const dynamic = 'force-dynamic';

const EMPTY: Paged<Order> = { items: [], total: 0 };

// First numbered page, server-rendered. Search / filter / page changes are fetched
// on demand by the client (server-side now — it no longer drains every page).
async function getOrders(): Promise<Paged<Order>> {
  const token = cookies().get(SESSION_COOKIE)?.value;
  if (!token) return EMPTY;
  const res = await fetch(`${API_BASE}/orders?page=1&limit=${ORDERS_PAGE_SIZE}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
  if (!res.ok) return EMPTY;
  return res.json();
}

export default async function OrdersPage() {
  const initial = await getOrders();
  return <OrdersClient initial={initial} />;
}
