import type { ConsolidatedProtocolOverrides } from '@/lib/types';

/** Toggle one order's membership in `excludedOrderIds` without disturbing
 *  extraRows/fieldOverrides — the edit screen's checkbox handler calls this
 *  and PATCHes the result, rather than hand-rolling array splicing inline
 *  (which is where an accidental duplicate/loss bug would hide). */
export function buildOverridesToggleExclude(
  current: ConsolidatedProtocolOverrides,
  orderId: string,
  exclude: boolean,
): ConsolidatedProtocolOverrides {
  const set = new Set(current.excludedOrderIds ?? []);
  if (exclude) set.add(orderId);
  else set.delete(orderId);
  return { ...current, excludedOrderIds: [...set] };
}
