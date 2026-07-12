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

  /**
   * Replace the whole list with a freshly fetched page (e.g. after a mutation that
   * invalidates the accumulated pages) AND reset the cursor to match it. Plain
   * `setItems` alone would leave a stale cursor: `loadMore` would then resume from
   * wherever the old pagination had gotten to (skipping/duplicating rows), and if
   * the farmer had already drained every page (`cursor === null`, `hasMore === false`)
   * the list would shrink to one page with no way to reach the rest short of a reload.
   */
  const replace = useCallback((page: Paginated<T>) => {
    setItems(page.items);
    setCursor(page.nextCursor);
  }, []);

  /**
   * Drain every remaining page in one go. Used when a client-side filter is active:
   * filtering only sees loaded items, so a filter can't be trusted until the whole
   * list is in memory. Loops on a LOCAL cursor (not the state one) so it isn't
   * tripped by React's async state updates; the `loading` guard blocks re-entry.
   *
   * Hard stop if a page returns the SAME cursor it was fetched with — the keyset
   * cursor is millisecond-precision (`toISOString`) while created_at can hold
   * microseconds, so a block of same-millisecond rows straddling a page boundary
   * makes the cursor stall (see keyset precision note). Without this guard that
   * stall is an infinite fetch loop that hangs the tab.
   */
  const loadAll = useCallback(async () => {
    if (!cursor || loading) return;
    setLoading(true);
    try {
      let next: string | null = cursor;
      while (next) {
        const used: string = next;
        const page = await fetchMore(used);
        setItems((prev) => [...prev, ...page.items]);
        next = page.nextCursor;
        setCursor(next);
        if (next === used) break; // cursor didn't advance → stop rather than loop forever
      }
    } finally {
      setLoading(false);
    }
  }, [cursor, loading, fetchMore]);

  return { items, setItems, loadMore, loadAll, replace, hasMore: cursor !== null, loading } as const;
}
