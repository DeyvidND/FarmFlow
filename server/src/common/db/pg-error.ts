/**
 * Postgres error codes we branch on. Add here rather than inlining a magic string.
 * @see https://www.postgresql.org/docs/current/errcodes-appendix.html
 */
const UNIQUE_VIOLATION = '23505';

/**
 * SQLSTATEs that a *malformed client input* produces against an otherwise
 * well-typed query — a garbage uuid/int/enum text (22P02 invalid_text_representation),
 * a garbage date/time string (22007 invalid_datetime_format), or an out-of-calendar
 * date like 2026-99-99 (22008 datetime_field_overflow). A correctly-typed server
 * query never raises these unless it was handed bad data from the request, so they
 * map to 400, not a 500 + Sentry page. Deliberately an allow-list, NOT the whole
 * class-22 range: 22012 (division_by_zero) / 22003 (numeric_value_out_of_range) can
 * signal a genuine server defect and must stay 500 (numeric overflow on the order
 * total is bounded explicitly at the source instead).
 */
const MALFORMED_INPUT_CODES = new Set(['22P02', '22007', '22008']);

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

/**
 * True for a pg data-exception caused by malformed request input (bad uuid / date /
 * calendar value), whether the error arrives bare or wrapped by drizzle. The
 * GlobalExceptionFilter turns these into a clean 400 instead of a 500, so an
 * untyped `@Query('date')` / bare `@Param('id')` that reaches a typed Postgres
 * column no longer surfaces as an internal-server-error (and Sentry noise). See
 * {@link MALFORMED_INPUT_CODES} for why it is an allow-list, not the class-22 range.
 */
export function isDataException(err: unknown): boolean {
  const code = pgCode(err);
  return code !== undefined && MALFORMED_INPUT_CODES.has(code);
}
