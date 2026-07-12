import { cookies } from 'next/headers';
import { API_BASE, SESSION_COOKIE } from '@/lib/session';
import { ArticlesClient } from '@/components/articles/articles-client';
import type { Article, Paginated } from '@/lib/types';

export const dynamic = 'force-dynamic';

const EMPTY: Paginated<Article> = { items: [], nextCursor: null };

async function getArticles(): Promise<Paginated<Article>> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return EMPTY;
  const res = await fetch(`${API_BASE}/articles?limit=50`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
  if (!res.ok) return EMPTY;
  return res.json();
}

export default async function ArticlesPage() {
  const initial = await getArticles();
  return <ArticlesClient initial={initial} />;
}
