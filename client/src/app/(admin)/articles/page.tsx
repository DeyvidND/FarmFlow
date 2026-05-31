import { cookies } from 'next/headers';
import { API_BASE, SESSION_COOKIE } from '@/lib/session';
import { ArticlesClient } from '@/components/articles/articles-client';
import type { Article } from '@/lib/types';

export const dynamic = 'force-dynamic';

async function getArticles(): Promise<Article[]> {
  const token = cookies().get(SESSION_COOKIE)?.value;
  if (!token) return [];
  const res = await fetch(`${API_BASE}/articles`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
  if (!res.ok) return [];
  return res.json();
}

export default async function ArticlesPage() {
  const articles = await getArticles();
  return <ArticlesClient initial={articles} />;
}
