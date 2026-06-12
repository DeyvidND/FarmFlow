import { cookies } from 'next/headers';
import { API_BASE, SESSION_COOKIE } from '@/lib/session';
import { InsightsClient } from '@/components/insights-client';
import type { PlatformInsights } from '@/lib/api-client';

export const dynamic = 'force-dynamic';

async function getInsights(): Promise<PlatformInsights | null> {
  const token = cookies().get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const res = await fetch(`${API_BASE}/platform/insights`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
  if (!res.ok) return null;
  return res.json();
}

export default async function InsightsPage() {
  const data = await getInsights();
  return <InsightsClient initial={data} />;
}
