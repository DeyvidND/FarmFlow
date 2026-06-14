/** Pure availability-window math. No DB, no tz: callers pass `today` as a
 *  'YYYY-MM-DD' BG-local string (from bgToday()). `date` columns serialize to the
 *  same lexically-comparable format, so string comparison is correct. */

export interface WindowRange {
  startsAt: string;
  endsAt: string;
}

/** The single window whose inclusive [startsAt, endsAt] covers `today`, or null.
 *  Callers guarantee non-overlap, so at most one matches; this returns the first. */
export function activeWindow<T extends WindowRange>(windows: T[], today: string): T | null {
  return windows.find((w) => w.startsAt <= today && today <= w.endsAt) ?? null;
}

/** True when two inclusive date ranges share any day. */
export function rangesOverlap(aFrom: string, aTo: string, bFrom: string, bTo: string): boolean {
  return aFrom <= bTo && bFrom <= aTo;
}

/** New `remaining` after a farmer edits a window's `quantity`. Preserves the
 *  amount already sold (`quantity - remaining`); floors at 0 so lowering quantity
 *  below what's sold can't produce a negative. */
export function applyQuantityDelta(
  w: { quantity: number; remaining: number },
  newQuantity: number,
): number {
  const sold = w.quantity - w.remaining;
  return Math.max(0, newQuantity - sold);
}

/** Checkout decision for one ordered item against its active window (or null when
 *  the product has no active window → today's behavior, no stock check). */
export function decideDecrement(
  active: { remaining: number } | null,
  qty: number,
): { ok: boolean; newRemaining: number | null } {
  if (!active) return { ok: true, newRemaining: null };
  if (active.remaining < qty) return { ok: false, newRemaining: null };
  return { ok: true, newRemaining: active.remaining - qty };
}

/** New `remaining` after returning `qty` to a still-active window on cancel,
 *  capped at the window's `quantity` so it can't exceed the original stock. */
export function restoreRemaining(w: { quantity: number; remaining: number }, qty: number): number {
  return Math.min(w.quantity, w.remaining + qty);
}
