import { DrizzleQueryError } from 'drizzle-orm';
import { isUniqueViolation } from './pg-error';

/** A real pg unique-violation error, as node-pg raises it. */
const pgUniqueViolation = () => Object.assign(new Error('duplicate key value'), { code: '23505' });

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
