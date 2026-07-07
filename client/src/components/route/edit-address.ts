import type { RouteStop } from '@/lib/types';

/** Which method the modal opens on. */
export type EditTab = 'address' | 'map';

/** A stop is "on the map" only when it has BOTH coordinates. */
export const stopIsLocated = (s: Pick<RouteStop, 'lat' | 'lng'>): boolean =>
  s.lat != null && s.lng != null;

/**
 * Default tab: if the stop already has a pin you're nudging an existing point
 * (open the map); otherwise you first need to find the address (open Адрес).
 */
export const initialEditTab = (s: Pick<RouteStop, 'lat' | 'lng'>): EditTab =>
  stopIsLocated(s) ? 'map' : 'address';

/**
 * Payload for the address tab. Send the trimmed address; when a Places
 * suggestion was picked, include its exact coords so the backend skips
 * geocoding (mirrors LocationRouteCard's homePin behaviour).
 */
export function addressPayload(
  addr: string,
  pin: { lat: number; lng: number } | null,
): { address: string; lat?: number; lng?: number } {
  const address = addr.trim();
  return pin ? { address, lat: pin.lat, lng: pin.lng } : { address };
}
