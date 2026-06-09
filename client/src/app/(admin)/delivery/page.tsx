import { cookies } from 'next/headers';
import { API_BASE, SESSION_COOKIE } from '@/lib/session';
import { DeliveryClient } from '@/components/delivery/delivery-client';
import type { StripeStatus } from '@/components/delivery/delivery-panel';
import type { DeliveryConfig, Slot } from '@/lib/types';

export const dynamic = 'force-dynamic';

// Seeded demo week (25–31 May 2026) — matches the Slots page.
const WEEK_FROM = '2026-05-25';
const WEEK_TO = '2026-05-31';

async function load(): Promise<{
  enabled: boolean;
  delivery: DeliveryConfig | null;
  slotFreeCount: number;
  stripe: StripeStatus;
}> {
  const token = cookies().get(SESSION_COOKIE)?.value;
  if (!token) return { enabled: false, delivery: null, slotFreeCount: 0, stripe: null };
  const headers = { Authorization: `Bearer ${token}` };

  const [tRes, sRes, stripeRes] = await Promise.all([
    fetch(`${API_BASE}/tenants/me`, { headers, cache: 'no-store' }),
    fetch(`${API_BASE}/slots?from=${WEEK_FROM}&to=${WEEK_TO}`, { headers, cache: 'no-store' }),
    // Card-payment status for the «Карта (онлайн)» card. Tolerate failure — the
    // card just shows "not connected" if Stripe is unreachable.
    fetch(`${API_BASE}/stripe/connect/summary`, { headers, cache: 'no-store' }).catch(() => null),
  ]);

  const tenant = tRes.ok ? await tRes.json() : {};
  const slots: Slot[] = sRes.ok ? await sRes.json() : [];
  const slotFreeCount = slots.reduce(
    (sum, s) => sum + Math.max(0, s.maxOrders - (s.booked ?? 0)),
    0,
  );

  let stripe: StripeStatus = null;
  if (stripeRes && stripeRes.ok) {
    const s = await stripeRes.json();
    stripe = {
      enabled: !!s.enabled,
      connected: !!s.connected,
      chargesEnabled: !!s.chargesEnabled,
    };
  }

  return {
    enabled: !!tenant.deliveryEnabled,
    delivery: (tenant.delivery as DeliveryConfig | null) ?? null,
    slotFreeCount,
    stripe,
  };
}

export default async function DeliveryPage() {
  const { enabled, delivery, slotFreeCount, stripe } = await load();
  return (
    <DeliveryClient
      initialEnabled={enabled}
      initialDelivery={delivery}
      slotFreeCount={slotFreeCount}
      stripe={stripe}
    />
  );
}
