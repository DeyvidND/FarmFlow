import { cookies } from 'next/headers';
import { API_BASE, SESSION_COOKIE } from '@/lib/session';
import { NewsletterClient } from '@/components/newsletter/newsletter-client';
import type { Subscriber } from '@/lib/api-client';
import type { Paginated } from '@/lib/types';

export const dynamic = 'force-dynamic';

interface SubscribersResponse extends Paginated<Subscriber> {
  activeCount: number;
  unsubscribedCount: number;
}

const EMPTY: SubscribersResponse = { items: [], nextCursor: null, activeCount: 0, unsubscribedCount: 0 };

async function getSubscribers(): Promise<SubscribersResponse> {
  const token = cookies().get(SESSION_COOKIE)?.value;
  if (!token) return EMPTY;
  const res = await fetch(`${API_BASE}/subscribers?limit=50`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
  if (!res.ok) return EMPTY;
  return res.json();
}

export default async function NewslettersPage() {
  const data = await getSubscribers();
  return (
    <NewsletterClient
      initial={{ items: data.items, nextCursor: data.nextCursor }}
      activeCount={data.activeCount}
      total={data.activeCount + data.unsubscribedCount}
    />
  );
}
