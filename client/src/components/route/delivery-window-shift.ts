/**
 * Inline delivery-window edit helpers (WP9). The farmer edits one stop's START
 * time on the route screen; the change is expressed as a signed minute DELTA and
 * cascaded to the following stops by the backend (POST /orders/route/windows/shift).
 * Pure functions — unit-tested without a DOM.
 */

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** True for a well-formed 24h 'HH:MM' wall-clock string. */
export function isHHMM(value: string): boolean {
  return HHMM.test(value);
}

/** Minutes since midnight for a valid 'HH:MM'. */
function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

/**
 * Signed minutes to shift so `oldStart` becomes `newStart` — the delta the inline
 * editor sends to the cascade endpoint. Returns 0 when the value is unchanged (the
 * caller skips the request) and null when either side isn't a valid 'HH:MM' (guard
 * against a half-typed native time input).
 */
export function windowShiftDeltaMin(oldStart: string, newStart: string): number | null {
  if (!isHHMM(oldStart) || !isHHMM(newStart)) return null;
  return toMinutes(newStart) - toMinutes(oldStart);
}
