import { cookies } from 'next/headers';
import { API_BASE, SESSION_COOKIE } from '@/lib/session';
import { NewsletterClient } from '@/components/newsletter/newsletter-client';
import type { Subscriber, NewsletterCampaign } from '@/lib/api-client';
import type { Paginated } from '@/lib/types';

export const dynamic = 'force-dynamic';

interface SubscribersResponse extends Paginated<Subscriber> {
  activeCount: number;
  unsubscribedCount: number;
}

const EMPTY_SUBS: SubscribersResponse = { items: [], nextCursor: null, activeCount: 0, unsubscribedCount: 0 };
const EMPTY_CAMPAIGNS: Paginated<NewsletterCampaign> = { items: [], nextCursor: null };

async function api<T>(path: string, token: string, fallback: T): Promise<T> {
  const res = await fetch(`${API_BASE}/${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
  if (!res.ok) return fallback;
  return res.json();
}

export default async function NewslettersPage() {
  const token = cookies().get(SESSION_COOKIE)?.value;
  if (!token) {
    return (
      <NewsletterClient
        initialCampaigns={[]}
        initialSubscribers={{ items: [], nextCursor: null }}
        activeCount={0}
        total={0}
      />
    );
  }

  const [subs, campaigns] = await Promise.all([
    api<SubscribersResponse>('subscribers?limit=50', token, EMPTY_SUBS),
    api<Paginated<NewsletterCampaign>>('newsletter/campaigns?limit=50', token, EMPTY_CAMPAIGNS),
  ]);

  return (
    <NewsletterClient
      initialCampaigns={campaigns.items}
      initialSubscribers={{ items: subs.items, nextCursor: subs.nextCursor }}
      activeCount={subs.activeCount}
      total={subs.activeCount + subs.unsubscribedCount}
    />
  );
}
