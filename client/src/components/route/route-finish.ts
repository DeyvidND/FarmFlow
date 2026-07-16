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

export type LatLng = { lat: number; lng: number };

/**
 * Where the map should start the REMAINING route line — i.e. where the courier
 * is now, not always the farm. Priority: live GPS (their real position) →
 * this-session's last finished drop → the persisted last-delivered position
 * (restored from localStorage so the anchor survives a reload, when the
 * delivered order has already dropped out of the confirmed-only route and the
 * session's finished set is gone). Returns `null` (⇒ start from the farm) when
 * there's no signal AND we shouldn't anchor: only a DRIVER (physically on the
 * route) anchors before finishing anything; an operator watching from the
 * office anchors only once a stop is actually marked done this session. Pure so
 * the priority + gating are unit-tested without the map.
 */
export function resolveRemainingStart(opts: {
  isDriver: boolean;
  finishedCount: number;
  selfPos: LatLng | null;
  lastFinished: LatLng | null;
  persisted: LatLng | null;
}): LatLng | null {
  const candidate = opts.selfPos ?? opts.lastFinished ?? opts.persisted;
  return opts.isDriver || opts.finishedCount > 0 ? candidate : null;
}
