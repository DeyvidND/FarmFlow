'use client';

import { useState, useCallback } from 'react';
import { toast } from 'sonner';
import { Star, CheckCircle, EyeOff, Clock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ApiError, listReviews, setReviewStatus } from '@/lib/api-client';
import type { AdminReview, Paginated, ReviewStatus } from '@/lib/types';

const STATUS_TABS: { key: ReviewStatus; label: string }[] = [
  { key: 'pending',   label: 'Чакащи' },
  { key: 'published', label: 'Публикувани' },
  { key: 'hidden',    label: 'Скрити' },
];

const EMPTY_PAGE: Paginated<AdminReview> = { items: [], nextCursor: null };

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Грешка');

function Stars({ value }: { value: number }) {
  return (
    <div className="flex gap-0.5" style={{ color: '#c77a0a' }}>
      {Array.from({ length: 5 }, (_, i) => (
        <Star
          key={i}
          size={14}
          strokeWidth={0}
          fill={i < value ? 'currentColor' : 'var(--ff-border)'}
        />
      ))}
    </div>
  );
}

function ReviewCard({
  review,
  onStatusChange,
}: {
  review: AdminReview;
  onStatusChange: (id: string, s: ReviewStatus) => void;
}) {
  const date = review.createdAt
    ? new Date(review.createdAt).toLocaleDateString('bg-BG', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      })
    : '';

  return (
    <article className="flex flex-col gap-3 rounded-[var(--ff-radius)] border border-ff-border bg-ff-surface p-[18px] shadow-ff-sm">
      <div className="flex items-start justify-between gap-2">
        <Stars value={review.rating} />
        <span className="shrink-0 text-[11px] text-ff-muted">{date}</span>
      </div>
      <p className="text-[14px] leading-relaxed text-ff-ink">„{review.body}"</p>
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <span className="text-[13px] font-bold text-ff-ink">{review.authorName}</span>
          {review.authorLocation && (
            <span className="ml-1.5 text-[12px] text-ff-muted">{review.authorLocation}</span>
          )}
        </div>
        <div className="flex shrink-0 gap-1.5">
          {review.status !== 'published' && (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 gap-1 px-2.5 text-xs font-bold text-ff-green-700 hover:bg-ff-green-50"
              onClick={() => onStatusChange(review.id, 'published')}
            >
              <CheckCircle size={13} /> Публикувай
            </Button>
          )}
          {review.status !== 'hidden' && (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 gap-1 px-2.5 text-xs font-bold text-ff-muted hover:bg-ff-surface-2"
              onClick={() => onStatusChange(review.id, 'hidden')}
            >
              <EyeOff size={13} /> Скрий
            </Button>
          )}
        </div>
      </div>
    </article>
  );
}

export function ReviewsClient({ initial }: { initial: Paginated<AdminReview> }) {
  const [activeTab, setActiveTab] = useState<ReviewStatus>('pending');
  const [pagesByTab, setPagesByTab] = useState<Record<ReviewStatus, Paginated<AdminReview>>>({
    pending:   initial,
    published: EMPTY_PAGE,
    hidden:    EMPTY_PAGE,
  });
  const [loadingTab, setLoadingTab] = useState<ReviewStatus | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const page = pagesByTab[activeTab];

  const fetchTab = useCallback(async (tab: ReviewStatus) => {
    setLoadingTab(tab);
    try {
      const data = await listReviews(tab);
      setPagesByTab((prev) => ({ ...prev, [tab]: data }));
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setLoadingTab(null);
    }
  }, []);

  async function switchTab(tab: ReviewStatus) {
    setActiveTab(tab);
    if (tab !== 'pending' && pagesByTab[tab].items.length === 0 && loadingTab !== tab) {
      await fetchTab(tab);
    }
  }

  async function loadMore() {
    if (!page.nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const next = await listReviews(activeTab, page.nextCursor);
      setPagesByTab((prev) => ({
        ...prev,
        [activeTab]: {
          items: [...prev[activeTab].items, ...next.items],
          nextCursor: next.nextCursor,
        },
      }));
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setLoadingMore(false);
    }
  }

  async function onStatusChange(id: string, newStatus: ReviewStatus) {
    setPagesByTab((prev) => ({
      ...prev,
      [activeTab]: {
        ...prev[activeTab],
        items: prev[activeTab].items.filter((r) => r.id !== id),
      },
    }));
    try {
      await setReviewStatus(id, newStatus);
      toast.success(newStatus === 'published' ? 'Публикувано' : 'Скрито');
      // Invalidate target tab so it re-fetches fresh on next visit
      setPagesByTab((prev) => ({ ...prev, [newStatus]: EMPTY_PAGE }));
    } catch (e) {
      toast.error(errMsg(e));
      await fetchTab(activeTab);
    }
  }

  const EMPTY_LABELS: Record<ReviewStatus, string> = {
    pending:   'Няма чакащи отзиви.',
    published: 'Няма публикувани отзиви.',
    hidden:    'Няма скрити отзиви.',
  };

  return (
    <div className="animate-ff-fade-up">
      {/* Tabs */}
      <div className="mb-5 flex gap-1 border-b border-ff-border">
        {STATUS_TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => switchTab(t.key)}
            className={[
              'flex items-center gap-1.5 border-b-2 px-4 py-2.5 text-[14px] font-bold transition-colors',
              activeTab === t.key
                ? 'border-ff-green-600 text-ff-green-800'
                : 'border-transparent text-ff-muted hover:text-ff-ink',
            ].join(' ')}
          >
            {t.label}
            {t.key === 'pending' && pagesByTab.pending.items.length > 0 && (
              <span className="grid h-[19px] min-w-[19px] place-items-center rounded-full bg-ff-amber-soft px-1 text-[11px] font-extrabold text-ff-amber-600">
                {pagesByTab.pending.items.length}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Content */}
      {loadingTab === activeTab ? (
        <p className="mt-10 text-center text-sm text-ff-muted">Зареждане…</p>
      ) : page.items.length === 0 ? (
        <div className="mt-16 flex flex-col items-center gap-3 text-center">
          <Clock size={36} className="text-ff-muted-2" />
          <p className="text-sm text-ff-muted">{EMPTY_LABELS[activeTab]}</p>
        </div>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] gap-4">
          {page.items.map((r) => (
            <ReviewCard key={r.id} review={r} onStatusChange={onStatusChange} />
          ))}
        </div>
      )}

      {/* Load more */}
      {page.nextCursor && (
        <div className="mt-6 flex justify-center">
          <button
            onClick={loadMore}
            disabled={loadingMore}
            className="rounded-xl border border-ff-border bg-ff-surface px-5 py-2.5 text-[14px] font-bold text-ff-ink-2 shadow-ff-sm hover:bg-ff-surface-2 disabled:opacity-60"
          >
            {loadingMore ? 'Зареждане…' : 'Зареди още'}
          </button>
        </div>
      )}
    </div>
  );
}
