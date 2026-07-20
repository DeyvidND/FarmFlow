import { DrizzleQueryError } from 'drizzle-orm';
import { isUniqueViolation, isDataException } from './pg-error';

/** A real pg unique-violation error, as node-pg raises it. */
const pgUniqueViolation = () => Object.assign(new Error('duplicate key value'), { code: '23505' });

/** A pg error with an arbitrary SQLSTATE, as node-pg raises it (bare). */
const pgErr = (code: string, msg = 'boom') => Object.assign(new Error(msg), { code });

describe('isUniqueViolation', () => {
  it('sees through drizzle wrapping — the pg code lives on err.cause, not err', () => {
    // drizzle-orm >= 0.44 wraps every pg-core query error in DrizzleQueryError,
    // which carries no `code` of its own. A guard testing `err.code === '23505'`
    // therefore never fires, and the intended 409 surfaces as a 500.
    const wrapped = new DrizzleQueryError('insert into "users" ...', [], pgUniqueViolation());

    expect((wrapped as unknown as { code?: string }).code).toBeUndefined();
    expect(isUniqueViolation(wrapped)).toBe(true);
  });

  it('still recognises a bare pg error (unwrapped driver paths)', () => {
    expect(isUniqueViolation(pgUniqueViolation())).toBe(true);
  });

  it('does not fire on a different pg error', () => {
    // 23503 = foreign_key_violation. Only 23505 may become a 409.
    const fk = Object.assign(new Error('fk violation'), { code: '23503' });
    expect(isUniqueViolation(fk)).toBe(false);
    expect(isUniqueViolation(new DrizzleQueryError('q', [], fk))).toBe(false);
  });

  it('does not fire on a non-pg error', () => {
    expect(isUniqueViolation(new Error('boom'))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
    expect(isUniqueViolation('23505')).toBe(false);
  });
});

describe('isDataException', () => {
  // The three SQLSTATEs a malformed-input request actually produces against a
  // well-typed query: a garbage uuid/int text (22P02), a garbage date string
  // (22007), or an out-of-calendar date like 2026-99-99 (22008). A well-typed
  // server query never raises these unless it was fed bad *client* input, so the
  // GlobalExceptionFilter maps them to 400 instead of a 500 + Sentry noise.
  it.each(['22P02', '22007', '22008'])('fires for malformed-input code %s (bare and drizzle-wrapped)', (code) => {
    expect(isDataException(pgErr(code))).toBe(true);
    expect(isDataException(new DrizzleQueryError('select ...', [], pgErr(code)))).toBe(true);
  });

  it('does NOT fire on unique-violation (23505) — that is a service-mapped 409, not a 400', () => {
    expect(isDataException(pgUniqueViolation())).toBe(false);
    expect(isDataException(new DrizzleQueryError('q', [], pgUniqueViolation()))).toBe(false);
  });

  it('does NOT blanket-map the whole class-22 range — 22012 division_by_zero is a server bug, not client input', () => {
    // Guards against a lazy `code.startsWith('22')`: some class-22 codes (division
    // by zero, indicator-overflow) signal a server defect and must stay 500.
    expect(isDataException(pgErr('22012'))).toBe(false);
  });

  it('does not fire on a non-pg error', () => {
    expect(isDataException(new Error('boom'))).toBe(false);
    expect(isDataException(new RangeError('Invalid time value'))).toBe(false);
    expect(isDataException(null)).toBe(false);
    expect(isDataException(undefined)).toBe(false);
  });
});
