'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, Newspaper, Trash2, Image as ImageIcon, Film } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { ApiError, createArticle, deleteArticle, listArticles } from '@/lib/api-client';
import { usePaginatedList } from '@/hooks/use-paginated-list';
import type { Article, Paginated } from '@/lib/types';

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Възникна грешка');

function shortDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('bg-BG', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function ArticleStatusBadge({ status }: { status: Article['status'] }) {
  const published = status === 'published';
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-[3px] text-xs font-bold',
        published ? 'bg-ff-green-100 text-ff-green-700' : 'bg-ff-amber-soft text-ff-amber-600',
      )}
    >
      <span className={cn('h-[7px] w-[7px] rounded-full', published ? 'bg-ff-green-500' : 'bg-ff-amber')} />
      {published ? 'Публикувана' : 'Чернова'}
    </span>
  );
}

export function ArticlesClient({ initial }: { initial: Paginated<Article> }) {
  const router = useRouter();
  const { items: articles, setItems: setArticles, loadMore, hasMore, loading } = usePaginatedList<Article>(
    initial,
    listArticles,
  );
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const publishedCount = articles.filter((a) => a.status === 'published').length;

  async function onCreate() {
    setCreating(true);
    try {
      const created = await createArticle({ title: 'Нова статия' });
      router.push(`/articles/${created.id}`);
    } catch (e) {
      toast.error(errMsg(e));
      setCreating(false);
    }
  }

  async function onDelete(a: Article, e: React.MouseEvent) {
    e.stopPropagation();
    if (!window.confirm(`Изтриване на „${a.title}“?`)) return;
    setBusyId(a.id);
    try {
      await deleteArticle(a.id);
      setArticles((prev) => prev.filter((x) => x.id !== a.id));
      toast.success('Статията е изтрита');
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="animate-ff-fade-up">
      <div className="mb-[18px] flex items-center justify-between">
        <p className="text-sm text-ff-muted">
          {publishedCount} публикувани · {articles.length} общо
        </p>
        <Button variant="primary" onClick={onCreate} disabled={creating} className="rounded-sm">
          <Plus size={18} /> {creating ? 'Създаване…' : 'Нова статия'}
        </Button>
      </div>

      {articles.length === 0 ? (
        <div className="mt-16 flex flex-col items-center gap-3 text-center">
          <Newspaper size={40} className="text-ff-muted-2" />
          <p className="text-sm text-ff-muted">Все още няма статии. Създай първата си статия.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-2.5">
          {articles.map((a, i) => (
            <button
              key={a.id}
              onClick={() => router.push(`/articles/${a.id}`)}
              style={{ animation: `ff-fade-up .35s ease ${i * 0.03}s both` }}
              className="group flex items-center gap-4 rounded-xl border border-ff-border bg-ff-surface p-3 text-left shadow-ff-sm transition-colors hover:border-ff-green-500 hover:bg-ff-green-50/40"
            >
              <Cover url={a.coverImageUrl} />

              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2.5">
                  <h3 className="truncate text-[15.5px] font-extrabold">{a.title || 'Без заглавие'}</h3>
                  <ArticleStatusBadge status={a.status} />
                </div>
                {a.excerpt && <p className="mt-1 truncate text-[13px] text-ff-muted">{a.excerpt}</p>}
                <div className="mt-1.5 flex items-center gap-3 text-[12px] font-semibold text-ff-muted">
                  <span>{a.status === 'published' ? shortDate(a.publishedAt) : 'не е публикувана'}</span>
                  <span className="inline-flex items-center gap-1">
                    <ImageIcon size={13} /> {a.media.length}
                  </span>
                </div>
              </div>

              <span
                role="button"
                tabIndex={0}
                aria-label="Изтрий"
                onClick={(e) => onDelete(a, e)}
                className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-ff-muted opacity-0 transition hover:bg-ff-red/10 hover:text-ff-red group-hover:opacity-100 [@media(hover:none)]:opacity-100 disabled:opacity-50"
              >
                {busyId === a.id ? <Film size={16} className="animate-pulse" /> : <Trash2 size={16} />}
              </span>
            </button>
          ))}
        </div>
      )}

      {hasMore && (
        <div className="mt-5 flex justify-center">
          <button
            onClick={loadMore}
            disabled={loading}
            className="rounded-xl border border-ff-border bg-ff-surface px-5 py-2.5 text-[14px] font-bold text-ff-ink-2 shadow-ff-sm hover:bg-ff-surface-2 disabled:opacity-60"
          >
            {loading ? 'Зареждане…' : 'Зареди още'}
          </button>
        </div>
      )}
    </div>
  );
}

function Cover({ url }: { url: string | null }) {
  if (url) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={url} alt="" loading="lazy" decoding="async" className="h-14 w-20 shrink-0 rounded-lg border border-ff-border object-cover" />;
  }
  return (
    <div className="grid h-14 w-20 shrink-0 place-items-center rounded-lg border border-ff-border-2 bg-ff-surface-2 text-ff-muted-2">
      <Newspaper size={20} />
    </div>
  );
}
