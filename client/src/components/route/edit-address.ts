/**
 * Payload for saving a route stop's delivery point. A pin (from a map click/
 * drag, or a picked address suggestion) is sent alongside the address text
 * when both are present; an empty address with a pin omits the `address` key
 * entirely so the server keeps the order's existing address (mirrors the
 * old map-only save path). No pin → address is required by the caller.
 */
export function mergedPayload(
  addr: string,
  pin: { lat: number; lng: number } | null,
): { address?: string; lat?: number; lng?: number } {
  const address = addr.trim();
  if (pin) return address ? { address, lat: pin.lat, lng: pin.lng } : { lat: pin.lat, lng: pin.lng };
  return { address };
}
