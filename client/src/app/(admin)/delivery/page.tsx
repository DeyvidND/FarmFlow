import { cookies } from 'next/headers';
import { API_BASE, SESSION_COOKIE } from '@/lib/session';
import { DeliveryClient } from '@/components/delivery/delivery-client';
import { computeSlotStatus } from '@/lib/delivery-data';
import type { DeliveryConfig, Slot, SlotRule } from '@/lib/types';

export const dynamic = 'force-dynamic';

/** Today's date in Bulgaria local time (YYYY-MM-DD), matching the API's day grouping. */
function bgToday(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Sofia',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}
/** Add `n` days to an ISO date string (UTC-stable, no TZ drift). */
function isoAddDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
/** The 7 dates (Mon→Sun) of the week containing today. */
function currentWeek(): string[] {
  const today = bgToday();
  const dow = new Date(`${today}T00:00:00Z`).getUTCDay(); // 0=Sun … 6=Sat
  const mondayOffset = dow === 0 ? -6 : 1 - dow;
  const monday = isoAddDays(today, mondayOffset);
  return Array.from({ length: 7 }, (_, i) => isoAddDays(monday, i));
}

/** Parse a JSON response, tolerating an empty body (e.g. `/slots/rule` → 200 + no body). */
async function readJson<T>(res: Response, fallback: T): Promise<T> {
  if (!res.ok) return fallback;
  const text = await res.text();
  return text ? (JSON.parse(text) as T) : fallback;
}

async function load(): Promise<{
  enabled: boolean;
  packageEnabled: boolean;
  delivery: DeliveryConfig | null;
  rule: SlotRule | null;
  freeThisWeek: number;
}> {
  const token = cookies().get(SESSION_COOKIE)?.value;
  if (!token) {
    return { enabled: false, packageEnabled: false, delivery: null, rule: null, freeThisWeek: 0 };
  }
  const headers = { Authorization: `Bearer ${token}` };
  const week = currentWeek();

  const [tRes, sRes, rRes] = await Promise.all([
    fetch(`${API_BASE}/tenants/me`, { headers, cache: 'no-store' }),
    fetch(`${API_BASE}/slots?from=${week[0]}&to=${week[6]}`, { headers, cache: 'no-store' }),
    fetch(`${API_BASE}/slots/rule`, { headers, cache: 'no-store' }),
  ]);

  const tenant = await readJson<{
    deliveryEnabled?: boolean;
    deliveriesPackageEnabled?: boolean;
    delivery?: DeliveryConfig;
  }>(tRes, {});
  const slots = await readJson<Slot[]>(sRes, []);
  const rule = await readJson<SlotRule | null>(rRes, null);
  // Free while booked is below capacity.
  const freeThisWeek = slots.reduce((sum, s) => sum + ((s.booked ?? 0) >= (s.capacity ?? 1) ? 0 : 1), 0);

  return {
    enabled: !!tenant.deliveryEnabled,
    // Absent (legacy payload) → treat as enabled so nothing hides unexpectedly.
    packageEnabled: tenant.deliveriesPackageEnabled !== false,
    delivery: tenant.delivery ?? null,
    rule,
    freeThisWeek,
  };
}

export default async function DeliveryPage() {
  const { enabled, packageEnabled, delivery, rule, freeThisWeek } = await load();
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
    <DeliveryClient
      initialEnabled={enabled}
      initialDelivery={delivery}
      slotStatus={computeSlotStatus(rule, freeThisWeek)}
    />
  );
}
