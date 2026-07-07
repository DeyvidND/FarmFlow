import { cookies } from 'next/headers';
import { API_BASE, SESSION_COOKIE } from '@/lib/session';
import { MyOrdersClient } from '@/components/my-orders/my-orders-client';
import type { FarmerOrdersPage } from '@/lib/api-client';

export const dynamic = 'force-dynamic';

const EMPTY_PAGE: FarmerOrdersPage = { orders: [], nextCursor: null };

async function getMyOrdersSsr(): Promise<FarmerOrdersPage> {
  const token = cookies().get(SESSION_COOKIE)?.value;
  if (!token) return EMPTY_PAGE;
  const res = await fetch(`${API_BASE}/orders/mine?limit=20`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  }).catch(() => null);
  if (!res || !res.ok) return EMPTY_PAGE;
  return res.json();
}

export default async function MyOrdersPage() {
  const initial = await getMyOrdersSsr();
  return (
    <div className="max-w-[980px]">
      <MyOrdersClient initial={initial} />
    </div>
  );
}
