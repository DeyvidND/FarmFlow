/**
 * Clamp a stored courier-pager position to the valid range for the CURRENT
 * courier count.
 *
 * The settings drawer keeps its pager position in state and stays mounted across
 * a soft-nav that changes the courier count, so a stored position can outlive the
 * count it was valid for. Deriving the safe position on every read (rather than
 * only clamping in the useState initializer) keeps the pager, the end-mode toggle
 * and its `onSetEndAt(pos, …)` call from ever addressing a courier that no longer
 * exists. Always ≥ 0, so zero couriers yields 0 rather than -1.
 */
export function clampPos(pos: number, count: number): number {
  return Math.min(Math.max(pos, 0), Math.max(count - 1, 0));
}
