/**
 * Pure delivery-window timing models (task #13 „full optimization"). Kept out of
 * routing.service so the arithmetic — service time per stop, smart window width —
 * is unit-tested without the DB/Maps. The service consumes these when turning a
 * courier's real per-leg drive times into per-order windows.
 */

/** Narrowest window we ever promise (minutes) — an early, predictable stop. */
export const WINDOW_MIN_WIDTH_MIN = 30;
/** Widest window (minutes) — a late stop with lots of accumulated delay risk. */
export const WINDOW_MAX_WIDTH_MIN = 90;
/** Extra window minutes per minute already driven (uncertainty grows downstream). */
export const WINDOW_WIDTH_GROWTH = 0.25;
/** Round the window WIDTH to this step (keeps widths tidy). */
export const WINDOW_GRAN_MIN = 5;
/** Round window START down to this granularity so customers see clean times. */
export const WINDOW_START_GRAN_MIN = 15;

/** Value thresholds (in lev) for the per-stop service-time bump. Bigger orders take
 *  longer to unload, hand over and count COD; order value is the available proxy
 *  (the route carries no item count). */
const SERVICE_BUMP_MED_LV = 50;
const SERVICE_BUMP_LARGE_LV = 150;
const SERVICE_BUMP_MED_MIN = 4;
const SERVICE_BUMP_LARGE_MIN = 8;

/**
 * Per-stop service (handover) minutes: the base plus a size bump. Capped tiers so
 * one very large order can't blow the whole day's schedule.
 */
export function serviceMinFor(totalStotinki: number, baseMin: number): number {
  const lv = (Number.isFinite(totalStotinki) ? totalStotinki : 0) / 100;
  const bump =
    lv > SERVICE_BUMP_LARGE_LV
      ? SERVICE_BUMP_LARGE_MIN
      : lv > SERVICE_BUMP_MED_LV
        ? SERVICE_BUMP_MED_MIN
        : 0;
  return Math.max(0, baseMin) + bump;
}

/**
 * Delivery-window width (minutes) for a stop reached after `cumulativeDriveMin`
 * of driving: widens with accumulated delay risk, rounded to WINDOW_GRAN_MIN and
 * clamped to [WINDOW_MIN_WIDTH_MIN, WINDOW_MAX_WIDTH_MIN].
 */
export function windowWidthMin(cumulativeDriveMin: number): number {
  const grown = WINDOW_MIN_WIDTH_MIN + WINDOW_WIDTH_GROWTH * Math.max(0, cumulativeDriveMin || 0);
  const rounded = Math.round(grown / WINDOW_GRAN_MIN) * WINDOW_GRAN_MIN;
  return Math.min(WINDOW_MAX_WIDTH_MIN, Math.max(WINDOW_MIN_WIDTH_MIN, rounded));
}

/** Round minutes-since-midnight down to a granularity (clean window starts). */
export function floorToMin(value: number, gran: number): number {
  return Math.floor(value / gran) * gran;
}
