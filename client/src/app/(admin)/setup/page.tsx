import { cookies } from 'next/headers';
import { API_BASE, SESSION_COOKIE } from '@/lib/session';
import { SetupPanel, type StripeStatus } from '@/components/panels/setup-panel';
import type { DeliveryConfig } from '@/lib/types';

export const dynamic = 'force-dynamic';

async function load(): Promise<{
  enabled: boolean;
  delivery: DeliveryConfig | null;
  stripe: StripeStatus;
}> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return { enabled: false, delivery: null, stripe: null };
  const headers = { Authorization: `Bearer ${token}` };

  const [tRes, stripeRes] = await Promise.all([
    fetch(`${API_BASE}/tenants/me`, { headers, cache: 'no-store' }),
    // Card-payment status for the «Карта (онлайн)» card. Tolerate failure.
    fetch(`${API_BASE}/stripe/connect/summary`, { headers, cache: 'no-store' }).catch(() => null),
  ]);

  const tenant = tRes.ok ? await tRes.json() : {};
  let stripe: StripeStatus = null;
  if (stripeRes && stripeRes.ok) {
    const s = await stripeRes.json();
    stripe = { enabled: !!s.enabled, connected: !!s.connected, chargesEnabled: !!s.chargesEnabled };
  }

  return {
    enabled: !!tenant.deliveryEnabled,
    delivery: (tenant.delivery as DeliveryConfig | null) ?? null,
    stripe,
  };
}

export default async function SetupPage() {
  const { enabled, delivery, stripe } = await load();
  return <SetupPanel initialEnabled={enabled} initialDelivery={delivery} stripe={stripe} />;
}
