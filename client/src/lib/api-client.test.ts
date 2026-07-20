import { afterEach, describe, expect, it, vi } from 'vitest';
import { confirmPending, getTenantLegal, getTodaySummary } from './api-client';

afterEach(() => {
  vi.unstubAllGlobals();
});

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

describe('getTodaySummary', () => {
  it('hits GET /dashboard/today with the date and returns the payload', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ date: '2026-07-20' }));
    vi.stubGlobal('fetch', fetchMock);
    const out = await getTodaySummary('2026-07-20');
    expect(fetchMock).toHaveBeenCalledWith('/bff/dashboard/today?date=2026-07-20', undefined);
    expect(out).toEqual({ date: '2026-07-20' });
  });

  it('omits the query string when no date is given', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ date: '2026-07-20' }));
    vi.stubGlobal('fetch', fetchMock);
    await getTodaySummary();
    expect(fetchMock).toHaveBeenCalledWith('/bff/dashboard/today', undefined);
  });
});

describe('confirmPending', () => {
  it('PATCHes /orders/confirm-pending with the date', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ confirmed: 3 }));
    vi.stubGlobal('fetch', fetchMock);
    const out = await confirmPending('2026-07-20');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/bff/orders/confirm-pending?date=2026-07-20');
    expect(init).toMatchObject({ method: 'PATCH' });
    expect(out).toEqual({ confirmed: 3 });
  });
});

/** A 200 with an empty body is how NestJS serializes a controller that returns
 *  `null` (e.g. tenants/me/legal before any legal data is saved). apiFetch must
 *  treat that as "no content" and resolve to null instead of throwing on
 *  res.json() of an empty string — otherwise the settings card can never load,
 *  so the operator can never save legal data the first time. */
describe('apiFetch empty-200 handling (getTenantLegal)', () => {
  it('resolves to a nullish value (not throw) when the API returns 200 with an empty body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('', { status: 200, headers: { 'content-type': 'application/json' } }),
      ),
    );
    // undefined here is fine — LegalCard reads `legal ?? {}`, so any nullish value
    // opens an empty form (and the Save bar) instead of erroring out.
    await expect(getTenantLegal()).resolves.toBeUndefined();
  });

  it('parses a normal JSON 200 body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ name: 'ЕТ Тест' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    await expect(getTenantLegal()).resolves.toEqual({ name: 'ЕТ Тест' });
  });
});
