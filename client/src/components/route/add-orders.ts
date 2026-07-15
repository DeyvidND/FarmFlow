import type { ReschedulableOrder } from '@/lib/types';

/**
 * Groups reschedulable orders by their source day (`slotDate`), excluding any
 * already scheduled for `routeDate` (nothing to add — they're already on this
 * route). Groups are sorted ascending by date.
 */
export function groupBySourceDay(
  rows: ReschedulableOrder[],
  routeDate: string,
): { date: string; orders: ReschedulableOrder[] }[] {
  const map = new Map<string, ReschedulableOrder[]>();
  for (const o of rows) {
    if (o.slotDate === routeDate) continue;
    const arr = map.get(o.slotDate) ?? [];
    arr.push(o);
    map.set(o.slotDate, arr);
  }
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, orders]) => ({ date, orders }));
}
