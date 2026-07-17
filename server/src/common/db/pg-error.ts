/**
 * Postgres error codes we branch on. Add here rather than inlining a magic string.
 * @see https://www.postgresql.org/docs/current/errcodes-appendix.html
 */
const UNIQUE_VIOLATION = '23505';

/** Pull a pg SQLSTATE off an error, looking through drizzle's wrapper. */
function pgCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const direct = (err as { code?: unknown }).code;
  if (typeof direct === 'string') return direct;
  // drizzle-orm >= 0.44 wraps every pg-core query error in DrizzleQueryError,
  // which carries the driver's error on `cause` and NO `code` of its own.
  const cause = (err as { cause?: unknown }).cause;
  if (typeof cause !== 'object' || cause === null) return undefined;
  const nested = (cause as { code?: unknown }).code;
  return typeof nested === 'string' ? nested : undefined;
}

/**
 * True for a pg unique-violation (23505), whether the error arrives bare or
 * wrapped by drizzle.
 *
 * Why this exists: `(err as { code?: string }).code === '23505'` reads fine and is
 * silently ALWAYS false under drizzle-orm 0.45 — the code sits at `err.cause.code`.
 * Two race guards shipped with that test (the day-assignment board's
 * tenant+date+leg constraint and grantAccess's users_email_unique backstop), so
 * both re-threw and surfaced as a 500 where a 409 was intended. Reach for this
 * instead of re-deriving the check at a third call site.
 */
export function isUniqueViolation(err: unknown): boolean {
  return pgCode(err) === UNIQUE_VIOLATION;
}
