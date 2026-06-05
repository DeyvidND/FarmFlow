import { cookies } from 'next/headers';
import { API_BASE, SESSION_COOKIE } from '@/lib/session';
import { OrdersClient } from '@/components/orders/orders-client';
import type { Order, Paginated } from '@/lib/types';

export const dynamic = 'force-dynamic';

const EMPTY: Paginated<Order> = { items: [], nextCursor: null };

async function getOrders(): Promise<Paginated<Order>> {
  const token = cookies().get(SESSION_COOKIE)?.value;
  if (!token) return EMPTY;
  const res = await fetch(`${API_BASE}/orders?limit=50`, {
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
