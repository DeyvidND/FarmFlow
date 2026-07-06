import type { RouteStop, RouteEnd } from '@/lib/types';

/** A place Waze can navigate to. Coordinates preferred; address is the fallback. */
export interface WazePoint {
  lat: number | null;
  lng: number | null;
  address: string | null;
}

/** One ordered destination in the Waze step-by-step navigator. */
export interface WazeTarget {
  /** Stable id — the stop id, or 'base' for the return-to-farm leg. */
  key: string;
  /** Human label: „Спирка 1" … or „Обратно към базата". */
  label: string;
  customer: string | null;
  address: string | null;
  lat: number | null;
  lng: number | null;
  slotFrom: string | null;
  slotTo: string | null;
}

/**
 * Waze universal deep link for a SINGLE destination. Opens the Waze app on
 * mobile (if installed), else Waze web. Waze always starts from the phone's
 * current GPS — there is no origin/waypoint parameter. Returns null when the
 * point has neither coordinates nor a usable address.
 */
export function wazeUrl(p: WazePoint): string | null {
  if (p.lat != null && p.lng != null) {
    const ll = encodeURIComponent(`${p.lat},${p.lng}`);
    return `https://www.waze.com/ul?ll=${ll}&navigate=yes`;
  }
  const q = p.address?.trim();
  if (q) return `https://www.waze.com/ul?q=${encodeURIComponent(q)}&navigate=yes`;
  return null;
}

/**
 * Ordered Waze targets for the day: every delivery stop in visit order, plus a
 * final „обратно към базата" leg when the route returns home (end.mode !==
 * 'last') and a base location is resolvable. The server fills `end` with the
 * farm's own coords for 'home' mode, so it already resolves to the base; the
 * `origin` param is only a fallback for a caller that passes an empty `end`.
 */
export function buildWazeTargets(
  stops: RouteStop[],
  end: RouteEnd,
  origin: WazePoint,
): WazeTarget[] {
  const targets: WazeTarget[] = stops.map((s, i) => ({
    key: s.id,
    label: `Спирка ${i + 1}`,
    customer: s.customer,
    address: s.address,
    lat: s.lat,
    lng: s.lng,
    slotFrom: s.slotFrom,
    slotTo: s.slotTo,
  }));

  if (end.mode !== 'last') {
    const endResolvable = end.lat != null || !!end.address?.trim();
    const base: WazePoint = endResolvable
      ? { lat: end.lat, lng: end.lng, address: end.address }
      : origin;
    if (wazeUrl(base)) {
      targets.push({
        key: 'base',
        label: 'Обратно към базата',
        customer: null,
        address: base.address,
        lat: base.lat,
        lng: base.lng,
        slotFrom: null,
        slotTo: null,
      });
    }
  }

  return targets;
}
