import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { API_BASE, SESSION_COOKIE } from '@/lib/session';
import { ArticleEditor } from '@/components/articles/article-editor';
import type { Article } from '@/lib/types';

export const dynamic = 'force-dynamic';

async function getArticle(id: string): Promise<Article | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const res = await fetch(`${API_BASE}/articles/${id}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
  if (!res.ok) return null;
  return res.json();
}

export default async function ArticleEditorPage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const article = await getArticle(params.id);
  if (!article) redirect('/articles');
  return <ArticleEditor initial={article} />;
}
