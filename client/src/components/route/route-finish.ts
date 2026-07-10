/**
 * Per-order "finish" pointer for the route card. Returns the first stop the
 * courier hasn't marked delivered yet (in the displayed stop order), or `null`
 * when every stop is done / the list is empty. Pure so it can be unit-tested
 * without the component.
 */
export function nextUnfinishedId(
  stops: { id: string }[],
  finished: ReadonlySet<string>,
): string | null {
  for (const s of stops) {
    if (!finished.has(s.id)) return s.id;
  }
  return null;
}
