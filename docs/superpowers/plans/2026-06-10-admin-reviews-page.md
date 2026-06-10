# Admin Reviews Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an admin panel page at `/reviews` where the farmer can see all submitted reviews (pending / published / hidden) and approve or hide each one.

**Architecture:** Pure frontend feature — the backend (`GET /reviews`, `PATCH /reviews/:id/status`) already exists and is tested. We add an `AdminReview` type, two API-client helpers, a React client component with tab-based status filtering, a Next.js server page, and a sidebar nav entry.

**Tech Stack:** Next.js 14 App Router (server + client components), React `useState`/`useMemo`, lucide-react icons, sonner toast, existing `apiFetch` / `Paginated<T>` patterns from the codebase.

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `client/src/lib/types.ts` | Modify | Add `AdminReview` + `ReviewStatus` type |
| `client/src/lib/api-client.ts` | Modify | Add `listReviews`, `setReviewStatus` |
| `client/src/components/reviews/reviews-client.tsx` | Create | Tab UI + cards + optimistic status changes |
| `client/src/app/(admin)/reviews/page.tsx` | Create | SSR: fetch pending reviews → pass to client |
| `client/src/components/layout/sidebar.tsx` | Modify | Add "Отзиви" nav item in Маркетинг group |

---

### Task 1: Add `AdminReview` type

**Files:**
- Modify: `client/src/lib/types.ts` (after the `Paginated<T>` block, before `ProductOption`)

- [ ] **Step 1: Add types**

Open `client/src/lib/types.ts` and insert after line 6 (after the closing `}` of `Paginated<T>`):

```typescript
export type ReviewStatus = 'pending' | 'published' | 'hidden';

/** Admin view of a review (GET /reviews). */
export interface AdminReview {
  id: string;
  authorName: string;
  authorLocation: string | null;
  rating: number;
  body: string;
  status: ReviewStatus;
  productId: string | null;
  createdAt: string;
}
```

- [ ] **Step 2: Commit**

```bash
git add client/src/lib/types.ts
git commit -m "feat(reviews): add AdminReview type"
```

---

### Task 2: Add API client helpers

**Files:**
- Modify: `client/src/lib/api-client.ts`

- [ ] **Step 1: Add import**

At the top of `client/src/lib/api-client.ts`, add `AdminReview, ReviewStatus` to the import list:

```typescript
import type {
  AdminReview,
  Article,
  // ... existing imports ...
  ReviewStatus,
  // ...
} from './types';
```

- [ ] **Step 2: Add helpers** (append near end of file, before the last `// ----` section or at EOF)

```typescript
// ---- Reviews ----

export const listReviews = (status?: ReviewStatus, cursor?: string) =>
  apiFetch<Paginated<AdminReview>>(`reviews${qs(cursor, undefined)}${status ? `${cursor ? '&' : '?'}status=${status}` : ''}`);

export const setReviewStatus = (id: string, status: ReviewStatus) =>
  apiFetch<AdminReview>(`reviews/${id}/status`, { method: 'PATCH', ...json({ status }) }, 'Неуспешна промяна');
```

Wait — the `qs` helper only sets cursor and limit. Build the query string correctly:

```typescript
// ---- Reviews ----

export const listReviews = (status?: ReviewStatus, cursor?: string) => {
  const p = new URLSearchParams();
  if (status) p.set('status', status);
  if (cursor) p.set('cursor', cursor);
  const q = p.toString();
  return apiFetch<Paginated<AdminReview>>(`reviews${q ? `?${q}` : ''}`);
};

export const setReviewStatus = (id: string, status: ReviewStatus) =>
  apiFetch<AdminReview>(`reviews/${id}/status`, { method: 'PATCH', ...json({ status }) }, 'Неуспешна промяна');
```

- [ ] **Step 3: Commit**

```bash
git add client/src/lib/api-client.ts
git commit -m "feat(reviews): add listReviews + setReviewStatus API helpers"
```

---

### Task 3: Create `ReviewsClient` component

**Files:**
- Create: `client/src/components/reviews/reviews-client.tsx`

- [ ] **Step 1: Create file**

```typescript
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

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Грешка');

function Stars({ value }: { value: number }) {
  return (
    <div className="flex gap-0.5" style={{ color: 'var(--ff-amber-600, #c77a0a)' }}>
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
    ? new Date(review.createdAt).toLocaleDateString('bg-BG', { day: 'numeric', month: 'long', year: 'numeric' })
    : '';

  return (
    <article className="flex flex-col gap-3 rounded-[var(--ff-radius)] border border-ff-border bg-ff-surface p-[18px] shadow-ff-sm">
      <div className="flex items-start justify-between gap-2">
        <Stars value={review.rating} />
        <span className="text-[11px] text-ff-muted">{date}</span>
      </div>
      <p className="text-[14px] leading-relaxed text-ff-ink">„{review.body}"</p>
      <div className="flex items-center justify-between gap-2">
        <div>
          <span className="text-[13px] font-bold text-ff-ink">{review.authorName}</span>
          {review.authorLocation && (
            <span className="ml-1.5 text-[12px] text-ff-muted">{review.authorLocation}</span>
          )}
        </div>
        <div className="flex gap-1.5">
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
    pending: initial,
    published: { items: [], nextCursor: null },
    hidden:    { items: [], nextCursor: null },
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
    // Fetch if not yet loaded (empty + not the initial pending tab)
    if (tab !== 'pending' && pagesByTab[tab].items.length === 0 && !loadingTab) {
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
        [activeTab]: { items: [...prev[activeTab].items, ...next.items], nextCursor: next.nextCursor },
      }));
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setLoadingMore(false);
    }
  }

  async function onStatusChange(id: string, newStatus: ReviewStatus) {
    // Optimistically remove from current tab + re-fetch target tab to keep counts fresh
    setPagesByTab((prev) => ({
      ...prev,
      [activeTab]: { ...prev[activeTab], items: prev[activeTab].items.filter((r) => r.id !== id) },
    }));
    try {
      await setReviewStatus(id, newStatus);
      toast.success(newStatus === 'published' ? 'Публикувано' : 'Скрито');
      // Invalidate target tab so it reloads fresh data next visit
      setPagesByTab((prev) => ({
        ...prev,
        [newStatus]: { items: [], nextCursor: null },
      }));
    } catch (e) {
      toast.error(errMsg(e));
      // Reload current tab to restore removed item
      await fetchTab(activeTab);
    }
  }

  const tabs = STATUS_TABS.map((t) => ({
    ...t,
    count: t.key === 'pending' ? pagesByTab.pending.items.length : undefined,
  }));

  return (
    <div className="animate-ff-fade-up">
      {/* Tabs */}
      <div className="mb-5 flex gap-1 border-b border-ff-border">
        {tabs.map((t) => (
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
          <p className="text-sm text-ff-muted">
            {activeTab === 'pending' ? 'Няма чакащи отзиви.' :
             activeTab === 'published' ? 'Няма публикувани отзиви.' :
             'Няма скрити отзиви.'}
          </p>
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
```

- [ ] **Step 2: Commit**

```bash
git add client/src/components/reviews/reviews-client.tsx
git commit -m "feat(reviews): add ReviewsClient component (tabs + cards + approve/hide)"
```

---

### Task 4: Create server page

**Files:**
- Create: `client/src/app/(admin)/reviews/page.tsx`

- [ ] **Step 1: Create file**

```typescript
import { cookies } from 'next/headers';
import { API_BASE, SESSION_COOKIE } from '@/lib/session';
import { ReviewsClient } from '@/components/reviews/reviews-client';
import type { AdminReview, Paginated } from '@/lib/types';

export const dynamic = 'force-dynamic';

const EMPTY: Paginated<AdminReview> = { items: [], nextCursor: null };

async function getPendingReviews(): Promise<Paginated<AdminReview>> {
  const token = cookies().get(SESSION_COOKIE)?.value;
  if (!token) return EMPTY;
  const res = await fetch(`${API_BASE}/reviews?status=pending&limit=50`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
  if (!res.ok) return EMPTY;
  return res.json();
}

export default async function ReviewsPage() {
  const initial = await getPendingReviews();
  return (
    <div className="animate-ff-fade-up">
      <div className="mb-[18px] flex items-center justify-between gap-2">
        <div>
          <h1 className="text-[22px] font-extrabold tracking-tight text-ff-ink">Отзиви</h1>
          <p className="mt-0.5 text-sm text-ff-muted">Преглед и одобрение на отзивите от клиенти.</p>
        </div>
      </div>
      <ReviewsClient initial={initial} />
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add "client/src/app/(admin)/reviews/page.tsx"
git commit -m "feat(reviews): add admin reviews server page"
```

---

### Task 5: Add sidebar nav item

**Files:**
- Modify: `client/src/components/layout/sidebar.tsx`

- [ ] **Step 1: Add `MessageSquare` icon import**

In `client/src/components/layout/sidebar.tsx`, add `MessageSquare` to the lucide-react import block:

```typescript
import {
  // ... existing icons ...
  MessageSquare,
  // ...
} from 'lucide-react';
```

- [ ] **Step 2: Add nav item to Маркетинг group**

In the `NAV_GROUPS` array, find the `'Маркетинг'` group and add the reviews item:

```typescript
{
  title: 'Маркетинг',
  collapsible: true,
  desc: 'Съдържание и комуникация с клиентите.',
  items: [
    { href: '/articles', label: 'Статии', Icon: Newspaper, gated: true, desc: 'Блог/новини секция в магазина.' },
    { href: '/reviews', label: 'Отзиви', Icon: MessageSquare, desc: 'Преглед и одобрение на отзивите от клиенти.' },
    { href: '/site-media', label: 'Снимки на сайта', Icon: ImageIcon, desc: 'Снимки за началната страница и секциите.' },
    { href: '/contacts', label: 'Контакти', Icon: Contact, desc: 'Контактна информация, социални мрежи, локация и иконка на сайта.' },
    { href: '/newsletters', label: 'Имейл клиенти', Icon: Mail, desc: 'Списък с имейли за бюлетин.' },
  ],
},
```

- [ ] **Step 3: Commit**

```bash
git add client/src/components/layout/sidebar.tsx
git commit -m "feat(reviews): add Отзиви to sidebar nav"
```
