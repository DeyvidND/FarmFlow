/** Order a set of fetched review rows by the farmer's pick order. Rows whose id
 *  is not in `ids` are dropped; ids with no matching row are skipped. Pure, so
 *  the DB query stays trivial and the ordering is unit-testable. */
export function orderReviewsByIds<T extends { id: string }>(ids: string[], rows: T[]): T[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out: T[] = [];
  for (const id of ids) {
    const r = byId.get(id);
    if (r) out.push(r);
  }
  return out;
}
