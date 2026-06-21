'use client';

import { useEffect, useRef, useState } from 'react';
import type { Paginated } from '@/lib/types';

/**
 * Seeds from the server-rendered first page, then walks every remaining keyset
 * page on mount so the *whole* list lives in memory. Lets the screen do its own
 * client-side filtering, search and page-numbered pagination over the full set
 * (not just the first server page). `setItems` is exposed for optimistic edits.
 */
export function useLoadAllList<T>(
  initial: Paginated<T>,
  fetchPage: (cursor: string) => Promise<Paginated<T>>,
) {
  const [items, setItems] = useState<T[]>(initial.items);
  const [loading, setLoading] = useState(initial.nextCursor !== null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    let cancelled = false;
    let cursor = initial.nextCursor;
    if (!cursor) {
      setLoading(false);
      return;
    }
    (async () => {
      try {
        while (cursor && !cancelled) {
          const page = await fetchPage(cursor);
          if (cancelled) return;
          setItems((prev) => [...prev, ...page.items]);
          cursor = page.nextCursor;
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { items, setItems, loading } as const;
}
