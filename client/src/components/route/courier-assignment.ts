/** One row of the per-day board (`GET/PUT orders/route/assignments`). */
export interface CourierAssignmentRow {
  accountId: string;
  legIndex: number;
}

/**
 * Precedence rule (spec §4.2, plan Task C2): the couriers-count dropdown is
 * the zero-config fast path; the board is the explicit override. Exactly one
 * of the two ever drives the leg count for a given date — never both:
 *
 * - Zero assignments for the date → the dropdown's own count still applies
 *   (today's unchanged behavior).
 * - One or more assignments → the leg count is the number of DISTINCT
 *   assigned legs, regardless of what the dropdown says (it becomes inert;
 *   see `isBoardActive`).
 */
export function deriveLegCount(assignments: CourierAssignmentRow[], dropdownCount: number): number {
  if (assignments.length === 0) return dropdownCount;
  return new Set(assignments.map((a) => a.legIndex)).size;
}

/**
 * True once the board holds >=1 assignment for the date — the moment the
 * couriers-count dropdown must go read-only/hidden (the board alone drives
 * the split server-side, Task A3). Kept as its own helper (rather than
 * inlining `assignments.length > 0` at each call site) so the board/dropdown
 * precedence is defined in exactly one place.
 */
export function isBoardActive(assignments: CourierAssignmentRow[]): boolean {
  return assignments.length > 0;
}

/**
 * Map a failed `PUT orders/route/assignments` to an inline, row-level error
 * string. A 409 (double-book — the same account or the same leg assigned
 * twice, including a concurrent-edit race caught by the DB's unique
 * constraints) already carries a user-facing Bulgarian message from the
 * server (`CourierAssignmentService.setAssignmentsForDay`) — surface it
 * as-is. Anything else falls back to a generic retry message; this never
 * throws, so callers can always render its result directly.
 */
export function assignmentErrorMessage(err: unknown): string {
  const status = (err as { status?: unknown } | null)?.status;
  const message = (err as { message?: unknown } | null)?.message;
  if (status === 409 && typeof message === 'string' && message) return message;
  return 'Неуспешно запазване — опитай пак';
}
