import { cookies } from 'next/headers';
import { API_BASE, SESSION_COOKIE } from '@/lib/session';
import { ReviewsClient } from '@/components/reviews/reviews-client';
import type { AdminReview, Paginated } from '@/lib/types';

export const dynamic = 'force-dynamic';

const EMPTY: Paginated<AdminReview> = { items: [], nextCursor: null };

async function getPendingReviews(): Promise<Paginated<AdminReview>> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
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
      <div className="mb-[18px] flex items-center gap-2">
        <div>
          <h1 className="text-[22px] font-extrabold tracking-tight text-ff-ink">Отзиви</h1>
          <p className="mt-0.5 text-sm text-ff-muted">Преглед и одобрение на отзивите от клиенти.</p>
        </div>
      </div>
      <ReviewsClient initial={initial} />
    </div>
  );
}
