import { cookies } from 'next/headers';
import { API_BASE, SESSION_COOKIE } from '@/lib/session';
import { OrdersClient } from '@/components/orders/orders-client';
import { ORDERS_PAGE_SIZE } from '@/lib/orders';
import type { DeliveryConfig, Order, Paged } from '@/lib/types';

export const dynamic = 'force-dynamic';

const EMPTY: Paged<Order> = { items: [], total: 0 };

async function getOrders(token: string | undefined): Promise<Paged<Order> & { ok: boolean }> {
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

/** Own delivery on = deliveryEnabled master switch AND the ownSlots method flag
 *  (ownSlots defaults on — mirrors buildPublicMethods + setup-panel). */
async function getOwnDeliveryEnabled(token: string | undefined): Promise<boolean> {
  if (!token) return false;
  try {
    const res = await fetch(`${API_BASE}/tenants/me`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
    });
    if (!res.ok) return false;
    const t = (await res.json()) as { deliveryEnabled?: boolean; delivery?: DeliveryConfig | null };
    return !!t.deliveryEnabled && (t.delivery?.methods?.ownSlots?.enabled ?? true);
  } catch {
    return false;
  }
}

export default async function OrdersPage() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const [{ ok, ...initial }, ownDeliveryEnabled] = await Promise.all([
    getOrders(token),
    getOwnDeliveryEnabled(token),
  ]);
  return <OrdersClient initial={initial} initialOk={ok} ownDeliveryEnabled={ownDeliveryEnabled} />;
}
