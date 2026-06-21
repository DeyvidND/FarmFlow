'use client';

import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

/** Page-number list with `…` gaps once there are too many pages to show all. */
function pageList(page: number, count: number): (number | 'gap')[] {
  if (count <= 7) return Array.from({ length: count }, (_, i) => i + 1);
  const out: (number | 'gap')[] = [1];
  const lo = Math.max(2, page - 1);
  const hi = Math.min(count - 1, page + 1);
  if (lo > 2) out.push('gap');
  for (let p = lo; p <= hi; p++) out.push(p);
  if (hi < count - 1) out.push('gap');
  out.push(count);
  return out;
}

const BTN =
  'inline-flex h-9 min-w-9 items-center justify-center rounded-lg border px-2.5 text-[13.5px] font-bold transition-colors';

/**
 * Numbered pagination footer (prev/next + page buttons, with `…` gaps).
 * Renders nothing for a single page. `total` (optional) adds an "общо N" caption.
 */
export function Pagination({
  page,
  pageCount,
  onPage,
  total,
  className,
}: {
  page: number;
  pageCount: number;
  onPage: (p: number) => void;
  total?: number;
  className?: string;
}) {
  if (pageCount <= 1) return null;
  return (
    <div className={cn('mt-5 flex flex-col items-center gap-2', className)}>
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => onPage(page - 1)}
          disabled={page <= 1}
          aria-label="Предишна страница"
          className={cn(
            BTN,
            'border-ff-border bg-ff-surface text-ff-ink-2 shadow-ff-sm hover:bg-ff-surface-2 disabled:cursor-not-allowed disabled:opacity-40',
          )}
        >
          <ChevronLeft size={16} />
        </button>
        {pageList(page, pageCount).map((p, i) =>
          p === 'gap' ? (
            <span key={`gap-${i}`} className="px-1 text-[13.5px] text-ff-muted">
              …
            </span>
          ) : (
            <button
              key={p}
              type="button"
              onClick={() => onPage(p)}
              aria-current={p === page ? 'page' : undefined}
              className={cn(
                BTN,
                p === page
                  ? 'border-ff-green-700 bg-ff-green-700 text-white shadow-ff-sm'
                  : 'border-ff-border bg-ff-surface text-ff-ink-2 shadow-ff-sm hover:bg-ff-surface-2',
              )}
            >
              {p}
            </button>
          ),
        )}
        <button
          type="button"
          onClick={() => onPage(page + 1)}
          disabled={page >= pageCount}
          aria-label="Следваща страница"
          className={cn(
            BTN,
            'border-ff-border bg-ff-surface text-ff-ink-2 shadow-ff-sm hover:bg-ff-surface-2 disabled:cursor-not-allowed disabled:opacity-40',
          )}
        >
          <ChevronRight size={16} />
        </button>
      </div>
      {total != null && (
        <div className="text-[12px] font-semibold text-ff-muted">
          Страница {page} от {pageCount} · общо {total}
        </div>
      )}
    </div>
  );
}
