import { HttpException, NotFoundException } from '@nestjs/common';
import { DrizzleQueryError } from 'drizzle-orm';
import type { ArgumentsHost } from '@nestjs/common';
import { GlobalExceptionFilter } from './global-exception.filter';

/** A bare pg error carrying a SQLSTATE, as node-pg raises it. */
const pgErr = (code: string, msg = 'db boom') => Object.assign(new Error(msg), { code });

function makeDb() {
  // recordErrorEvent (only for 5xx) does db.insert(...).values(...).catch(...).
  const values = jest.fn().mockReturnValue({ catch: jest.fn().mockResolvedValue(undefined) });
  const insert = jest.fn().mockReturnValue({ values });
  return { db: { insert } as any, insert, values };
}

function makeHost() {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  const req = { method: 'GET', originalUrl: '/orders/route', url: '/orders/route', user: null };
  const host = {
    switchToHttp: () => ({ getResponse: () => ({ status }), getRequest: () => req }),
  } as unknown as ArgumentsHost;
  return { host, status, json };
}

describe('GlobalExceptionFilter — malformed-input → 400', () => {
  let filter: GlobalExceptionFilter;
  let insert: jest.Mock;

  beforeEach(() => {
    const d = makeDb();
    insert = d.insert;
    filter = new GlobalExceptionFilter(d.db);
  });

  it('maps a pg invalid-uuid/int (22P02) to 400, not 500 — a mistyped :id or query uuid', () => {
    const { host, status, json } = makeHost();
    filter.catch(new DrizzleQueryError('select ...', [], pgErr('22P02', 'invalid input syntax for type uuid: "x"')), host);

    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    // 4xx is a client error — never Sentry/error-feed noise.
    expect(insert).not.toHaveBeenCalled();
    // The pg message (leaks column/type/constraint detail) must not reach the client.
    const body = json.mock.calls[0][0];
    expect(JSON.stringify(body)).not.toContain('invalid input syntax');
  });

  it('maps a pg invalid-date (22007) to 400', () => {
    const { host, status } = makeHost();
    filter.catch(new DrizzleQueryError('select ...', [], pgErr('22007', 'invalid input syntax for type date: "garbage"')), host);
    expect(status).toHaveBeenCalledWith(400);
  });

  it('maps a JS RangeError "Invalid time value" to 400 — the Date(NaN) path from a bad date query', () => {
    // GET /orders/route?date=garbage → bgDayBounds → new Date(NaN) → Intl throws
    // RangeError BEFORE any query, so the pg-code branch can't catch it.
    const { host, status } = makeHost();
    filter.catch(new RangeError('Invalid time value'), host);
    expect(status).toHaveBeenCalledWith(400);
  });

  it('leaves an unrelated RangeError as 500 (only "Invalid time value" is client input)', () => {
    const { host, status } = makeHost();
    filter.catch(new RangeError('Maximum call stack size exceeded'), host);
    expect(status).toHaveBeenCalledWith(500);
    expect(insert).toHaveBeenCalled();
  });

  it('does NOT downgrade a unique-violation (23505) — services map that to 409 themselves', () => {
    const { host, status } = makeHost();
    filter.catch(new DrizzleQueryError('insert ...', [], pgErr('23505')), host);
    expect(status).toHaveBeenCalledWith(500);
  });

  it('passes an HttpException through with its own status', () => {
    const { host, status } = makeHost();
    filter.catch(new NotFoundException('nope'), host);
    expect(status).toHaveBeenCalledWith(404);
    expect(insert).not.toHaveBeenCalled();
  });

  it('still 500s an ordinary server error and records it', () => {
    const { host, status } = makeHost();
    filter.catch(new Error('kaboom'), host);
    expect(status).toHaveBeenCalledWith(500);
    expect(insert).toHaveBeenCalled();
  });

  it('is defensive: HttpException base class still resolves its status', () => {
    const { host, status } = makeHost();
    filter.catch(new HttpException('teapot', 418), host);
    expect(status).toHaveBeenCalledWith(418);
  });
});
