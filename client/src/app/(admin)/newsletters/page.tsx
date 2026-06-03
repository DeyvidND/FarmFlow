import { cookies } from 'next/headers';
import { API_BASE, SESSION_COOKIE } from '@/lib/session';
import { NewsletterClient } from '@/components/newsletter/newsletter-client';

export const dynamic = 'force-dynamic';

interface SubscribersResponse {
  subscribers: { id: string; email: string; createdAt: string | null }[];
  activeCount: number;
  unsubscribedCount: number;
}

async function getSubscribers(): Promise<SubscribersResponse> {
  const token = cookies().get(SESSION_COOKIE)?.value;
  if (!token) return { subscribers: [], activeCount: 0, unsubscribedCount: 0 };
  const res = await fetch(`${API_BASE}/subscribers`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
  if (!res.ok) return { subscribers: [], activeCount: 0, unsubscribedCount: 0 };
  return res.json();
}

export default async function NewslettersPage() {
  const data = await getSubscribers();
  return <NewsletterClient subscribers={data.subscribers} activeCount={data.activeCount} />;
}
