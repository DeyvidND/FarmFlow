import { cookies } from 'next/headers';
import { API_BASE, SESSION_COOKIE } from '@/lib/session';
import { OrdersClient } from '@/components/orders/orders-client';
import type { Order } from '@/lib/types';

export const dynamic = 'force-dynamic';

async function getOrders(): Promise<Order[]> {
  const token = cookies().get(SESSION_COOKIE)?.value;
  if (!token) return [];
  const res = await fetch(`${API_BASE}/orders`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
  if (!res.ok) return [];
  return res.json();
}

export default async function OrdersPage() {
  const orders = await getOrders();
  return <OrdersClient initial={orders} />;
}
