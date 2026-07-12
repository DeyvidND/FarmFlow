import { cookies } from 'next/headers';
import { API_BASE, SESSION_COOKIE } from '@/lib/session';
import { ProducersMapClient } from './producers-map-client';
import type { ProducersMapResult } from '@/lib/api-client';

export const dynamic = 'force-dynamic';

const EMPTY: ProducersMapResult = { producers: [], withLocation: 0, withoutLocation: 0, mapsEnabled: false };

async function getProducersMap(): Promise<ProducersMapResult> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return EMPTY;
  const res = await fetch(`${API_BASE}/platform/producers/map`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
  if (!res.ok) return EMPTY;
  return res.json();
}

export default async function ProducersMapPage() {
  const initial = await getProducersMap();
  return <ProducersMapClient initial={initial} />;
}
