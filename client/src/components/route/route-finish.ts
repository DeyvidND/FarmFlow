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

/**
 * The stop to highlight after finishing `fromId`: the first unfinished stop
 * AFTER it in the displayed order, wrapping to the top — so finishing a stop
 * picked mid-route advances to the courier's next logical stop instead of
 * jumping back to the start of the list. Unknown `fromId` (or none after it)
 * falls back to the first unfinished overall; `null` when everything is done.
 */
export function nextUnfinishedAfter(
  stops: { id: string }[],
  finished: ReadonlySet<string>,
  fromId: string,
): string | null {
  const at = stops.findIndex((s) => s.id === fromId);
  if (at >= 0) {
    for (let k = 1; k <= stops.length; k++) {
      const s = stops[(at + k) % stops.length];
      if (!finished.has(s.id)) return s.id;
    }
    return null;
  }
  return nextUnfinishedId(stops, finished);
}
