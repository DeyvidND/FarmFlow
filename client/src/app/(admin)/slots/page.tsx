import { cookies } from 'next/headers';
import { API_BASE, SESSION_COOKIE } from '@/lib/session';
import { SlotsClient } from '@/components/slots/slots-client';
import type { Slot, SlotRule } from '@/lib/types';

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

/** The 7 dates (Mon→Sun) of the week containing today, plus today itself. */
function currentWeek(): { days: string[]; today: string } {
  const today = bgToday();
  const dow = new Date(`${today}T00:00:00Z`).getUTCDay(); // 0=Sun … 6=Sat
  const mondayOffset = dow === 0 ? -6 : 1 - dow;
  const monday = isoAddDays(today, mondayOffset);
  return { days: Array.from({ length: 7 }, (_, i) => isoAddDays(monday, i)), today };
}

async function load(
  week: string[],
): Promise<{ slots: Slot[]; delivery: boolean; rule: SlotRule | null }> {
  const token = cookies().get(SESSION_COOKIE)?.value;
  if (!token) return { slots: [], delivery: false, rule: null };
  const headers = { Authorization: `Bearer ${token}` };

  const [sRes, tRes, rRes] = await Promise.all([
    fetch(`${API_BASE}/slots?from=${week[0]}&to=${week[6]}`, { headers, cache: 'no-store' }),
    fetch(`${API_BASE}/tenants/me`, { headers, cache: 'no-store' }),
    fetch(`${API_BASE}/slots/rule`, { headers, cache: 'no-store' }),
  ]);

  const slots = sRes.ok ? await sRes.json() : [];
  const tenant = tRes.ok ? await tRes.json() : {};
  const rule = rRes.ok ? await rRes.json() : null;
  return { slots, delivery: !!tenant.deliveryEnabled, rule };
}

export default async function SlotsPage() {
  const { days, today } = currentWeek();
  const { slots, delivery, rule } = await load(days);
  return (
    <SlotsClient
      initialSlots={slots}
      initialRule={rule}
      days={days}
      today={today}
      deliveryEnabled={delivery}
    />
  );
}
