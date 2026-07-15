/**
 * Pure helpers for the manual delivery-order override on the route page.
 *
 * The server hands back an auto-optimized stop order; a farmer can override it
 * (see route-client). The override is stored as a plain list of stop ids in
 * localStorage. These functions keep that id list and the live server stop set
 * in sync, and apply reorder moves — no React, no I/O, so they unit-test cleanly.
 */

/**
 * Order `serverStops` by the saved manual id list. Stops still present keep the
 * manual order; stops added since the order was saved (ids not in `manualIds`)
 * are appended in server order; ids no longer present are dropped. `null`
 * manualIds means "no override" — the server order is returned unchanged.
 */
export function reconcileOrder<T extends { id: string }>(
  serverStops: T[],
  manualIds: string[] | null,
): T[] {
  if (!manualIds) return serverStops;
  const byId = new Map(serverStops.map((s) => [s.id, s]));
  const picked = manualIds.map((id) => byId.get(id)).filter((s): s is T => s != null);
  const seen = new Set(picked.map((s) => s.id));
  const appended = serverStops.filter((s) => !seen.has(s.id));
  return [...picked, ...appended];
}

/**
 * New id list with the item at `index` moved one slot up (dir -1) or down
 * (dir +1). Out-of-range moves (past either end) return the list unchanged.
 */
export function moveInOrder(ids: string[], index: number, dir: -1 | 1): string[] {
  const to = index + dir;
  if (index < 0 || index >= ids.length || to < 0 || to >= ids.length) return ids;
  const next = [...ids];
  [next[index], next[to]] = [next[to], next[index]];
  return next;
}

/**
 * New id list with the item at `from` removed and re-inserted at `to`
 * (drag-and-drop). No-op indices or a from===to move return the list unchanged.
 */
export function dragInOrder(ids: string[], from: number, to: number): string[] {
  if (from === to || from < 0 || from >= ids.length || to < 0 || to >= ids.length) return ids;
  const next = [...ids];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/**
 * Multi-leg variant for the reorder modal: `byLeg` is one ordered id list per
 * courier leg. Move the id at `from` (leg + index) to `toLeg` — within the
 * same leg it's a dragInOrder to `toIdx`; across legs the id leaves its list
 * and lands at `toIdx` of the target (or is appended when `toIdx` is omitted,
 * e.g. the per-row courier dropdown or the section-tail drop zone). A missing
 * source id returns `byLeg` unchanged.
 */
export function transferInLegs(
  byLeg: string[][],
  from: { leg: number; idx: number },
  toLeg: number,
  toIdx?: number,
): string[][] {
  if (from.leg === toLeg) {
    if (toIdx == null) return byLeg;
    return byLeg.map((ids, li) => (li === toLeg ? dragInOrder(ids, from.idx, toIdx) : ids));
  }
  const id = byLeg[from.leg]?.[from.idx];
  if (id == null || byLeg[toLeg] == null) return byLeg;
  return byLeg.map((ids, li) => {
    if (li === from.leg) return ids.filter((x) => x !== id);
    if (li === toLeg) {
      const next = [...ids];
      next.splice(toIdx ?? next.length, 0, id);
      return next;
    }
    return ids;
  });
}
