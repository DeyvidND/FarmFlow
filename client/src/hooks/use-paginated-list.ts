'use client';

import { useState, useCallback } from 'react';
import type { Paginated } from '@/lib/types';

/**
 * Accumulating keyset-pagination state. Seeds from the server-rendered first page,
 * appends further pages via `fetchMore(cursor)`. Filtering/search stay client-side
 * over `items` (no refetch). `setItems` is exposed for optimistic create/update/delete.
 */
export function usePaginatedList<T>(
  initial: Paginated<T>,
  fetchMore: (cursor: string) => Promise<Paginated<T>>,
) {
  const [items, setItems] = useState<T[]>(initial.items);
  const [cursor, setCursor] = useState<string | null>(initial.nextCursor);
  const [loading, setLoading] = useState(false);

  const loadMore = useCallback(async () => {
    if (!cursor || loading) return;
    setLoading(true);
    try {
      const page = await fetchMore(cursor);
      setItems((prev) => [...prev, ...page.items]);
      setCursor(page.nextCursor);
    } finally {
      setLoading(false);
    }
  }, [cursor, loading, fetchMore]);

  return { items, setItems, loadMore, hasMore: cursor !== null, loading } as const;
}
