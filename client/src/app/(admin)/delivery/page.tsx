import { cookies } from 'next/headers';
import { API_BASE, SESSION_COOKIE } from '@/lib/session';
import { DeliveryClient } from '@/components/delivery/delivery-client';
import type { DeliveryConfig, Slot } from '@/lib/types';

export const dynamic = 'force-dynamic';

// Seeded demo week (25–31 May 2026) — matches the Slots page.
const WEEK_FROM = '2026-05-25';
const WEEK_TO = '2026-05-31';

async function load(): Promise<{
  enabled: boolean;
  delivery: DeliveryConfig | null;
  slotFreeCount: number;
}> {
  const token = cookies().get(SESSION_COOKIE)?.value;
  if (!token) return { enabled: false, delivery: null, slotFreeCount: 0 };
  const headers = { Authorization: `Bearer ${token}` };

  const [tRes, sRes] = await Promise.all([
    fetch(`${API_BASE}/tenants/me`, { headers, cache: 'no-store' }),
    fetch(`${API_BASE}/slots?from=${WEEK_FROM}&to=${WEEK_TO}`, { headers, cache: 'no-store' }),
  ]);

  const tenant = tRes.ok ? await tRes.json() : {};
  const slots: Slot[] = sRes.ok ? await sRes.json() : [];
  const slotFreeCount = slots.reduce(
    (sum, s) => sum + Math.max(0, s.maxOrders - (s.booked ?? 0)),
    0,
  );

  return {
    enabled: !!tenant.deliveryEnabled,
    delivery: (tenant.delivery as DeliveryConfig | null) ?? null,
    slotFreeCount,
  };
}

export default async function DeliveryPage() {
  const { enabled, delivery, slotFreeCount } = await load();
  return (
    <DeliveryClient initialEnabled={enabled} initialDelivery={delivery} slotFreeCount={slotFreeCount} />
  );
}
