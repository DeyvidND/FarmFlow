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

/** A first digit that can only be a single-digit hour (3–9) gets a leading 0,
 *  so '930' reads as 09:30 — the numeric mobile keyboard has no ':' key. */
const padHourDigits = (digits: string): string =>
  digits && digits[0] >= '3' ? `0${digits}` : digits;

/**
 * Display mask while typing a 24h time: keep only digits (max 4), pad an
 * unambiguous single-digit hour, and re-insert the ':' after the hour. Lets a
 * numeric keyboard type '1530'/'930' and read back '15:30'/'09:30' — the native
 * `<input type="time">` this replaces rendered 12h AM/PM on devices with a
 * 12-hour locale, so half the badge showed '03:30 PM' next to a static 24h
 * '–16:10'.
 */
export function formatTimeDigits(raw: string): string {
  const digits = padHourDigits(raw.replace(/\D/g, '')).slice(0, 4);
  return digits.length <= 2 ? digits : `${digits.slice(0, 2)}:${digits.slice(2)}`;
}

/**
 * Normalize a finished (blurred) time entry to strict 'HH:MM', or null when it
 * can't be one. Accepts '15:30', '9:30', '1530' and '930' (→ '09:30'); an
 * entry it can't read unambiguously (e.g. '15:3') returns null and the caller
 * reverts to the last persisted value — never guess a time.
 */
export function normalizeHHMM(raw: string): string | null {
  let hh: number;
  let mm: number;
  if (raw.includes(':')) {
    const [h, m] = raw.split(':');
    if (!/^\d{1,2}$/.test(h) || !/^\d{2}$/.test(m)) return null;
    hh = Number(h);
    mm = Number(m);
  } else {
    const digits = padHourDigits(raw.replace(/\D/g, ''));
    if (digits.length !== 4) return null;
    hh = Number(digits.slice(0, 2));
    mm = Number(digits.slice(2));
  }
  if (hh > 23 || mm > 59) return null;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}
