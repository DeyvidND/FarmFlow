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
  packageEnabled: boolean;
  delivery: DeliveryConfig | null;
  slotFreeCount: number;
}> {
  const token = cookies().get(SESSION_COOKIE)?.value;
  if (!token) return { enabled: false, packageEnabled: false, delivery: null, slotFreeCount: 0 };
  const headers = { Authorization: `Bearer ${token}` };

  const [tRes, sRes] = await Promise.all([
    fetch(`${API_BASE}/tenants/me`, { headers, cache: 'no-store' }),
    fetch(`${API_BASE}/slots?from=${WEEK_FROM}&to=${WEEK_TO}`, { headers, cache: 'no-store' }),
  ]);

  const tenant = tRes.ok ? await tRes.json() : {};
  const slots: Slot[] = sRes.ok ? await sRes.json() : [];
  // Each slot holds one order → free = no live booking.
  const slotFreeCount = slots.reduce((sum, s) => sum + ((s.booked ?? 0) >= 1 ? 0 : 1), 0);

  return {
    enabled: !!tenant.deliveryEnabled,
    // Absent (legacy payload) → treat as enabled so nothing hides unexpectedly.
    packageEnabled: tenant.deliveriesPackageEnabled !== false,
    delivery: (tenant.delivery as DeliveryConfig | null) ?? null,
    slotFreeCount,
  };
}

export default async function DeliveryPage() {
  const { enabled, packageEnabled, delivery, slotFreeCount } = await load();
  if (!packageEnabled) {
    return (
      <div className="animate-ff-fade-up mx-auto mt-10 max-w-[520px] rounded-[14px] border border-ff-border bg-ff-surface p-6 text-center">
        <h1 className="font-display text-[20px] font-extrabold text-ff-ink">Доставки не са включени</h1>
        <p className="mt-2 text-[14px] leading-relaxed text-ff-ink-2">
          Пакетът „Доставки“ не е активен за този магазин. За да приемаш поръчки с куриер (Еконт/Speedy)
          и да печаташ товарителници, се свържи с екипа на ФермериБГ да го активира.
        </p>
      </div>
    );
  }
  return (
    <DeliveryClient initialEnabled={enabled} initialDelivery={delivery} slotFreeCount={slotFreeCount} />
  );
}
