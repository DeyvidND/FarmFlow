import { cookies } from 'next/headers';
import { API_BASE, SESSION_COOKIE } from '@/lib/session';
import { SlotsClient } from '@/components/slots/slots-client';
import type { Slot } from '@/lib/types';

export const dynamic = 'force-dynamic';

// Seeded demo week (25–31 May 2026).
const WEEK = [
  '2026-05-25',
  '2026-05-26',
  '2026-05-27',
  '2026-05-28',
  '2026-05-29',
  '2026-05-30',
  '2026-05-31',
];

async function load(): Promise<{ slots: Slot[]; delivery: boolean }> {
  const token = cookies().get(SESSION_COOKIE)?.value;
  if (!token) return { slots: [], delivery: false };
  const headers = { Authorization: `Bearer ${token}` };

  const [sRes, tRes] = await Promise.all([
    fetch(`${API_BASE}/slots?from=${WEEK[0]}&to=${WEEK[6]}`, { headers, cache: 'no-store' }),
    fetch(`${API_BASE}/tenants/me`, { headers, cache: 'no-store' }),
  ]);

  const slots = sRes.ok ? await sRes.json() : [];
  const tenant = tRes.ok ? await tRes.json() : {};
  return { slots, delivery: !!tenant.deliveryEnabled };
}

export default async function SlotsPage() {
  const { slots, delivery } = await load();
  return <SlotsClient initialSlots={slots} days={WEEK} deliveryEnabled={delivery} />;
}
