import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  confirmPending, getTenantLegal, getTodaySummary,
  ensureConsolidatedProtocol, getConsolidatedProtocol, listConsolidatedProtocols,
  signConsolidatedProtocol, updateConsolidatedProtocol, consolidatedProtocolPdfHref,
  getConsolidatedCourierRecipients, sendConsolidatedToCouriers,
} from './api-client';

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

describe('consolidated protocol API client', () => {
  it('listConsolidatedProtocols hits GET /consolidated-protocols with the date', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([]));
    vi.stubGlobal('fetch', fetchMock);
    await listConsolidatedProtocols('2026-07-22');
    expect(fetchMock).toHaveBeenCalledWith('/bff/consolidated-protocols?date=2026-07-22', undefined);
  });

  it('ensureConsolidatedProtocol POSTs the scope/date/legIndex', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: 'cp1' }));
    vi.stubGlobal('fetch', fetchMock);
    const out = await ensureConsolidatedProtocol({ date: '2026-07-22', scope: 'leg', legIndex: 1 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/bff/consolidated-protocols/ensure');
    expect(init).toMatchObject({ method: 'POST' });
    expect(JSON.parse(init.body)).toEqual({ date: '2026-07-22', scope: 'leg', legIndex: 1 });
    expect(out).toEqual({ id: 'cp1' });
  });

  it('getConsolidatedProtocol hits GET /consolidated-protocols/:id', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: 'cp1' }));
    vi.stubGlobal('fetch', fetchMock);
    await getConsolidatedProtocol('cp1');
    expect(fetchMock).toHaveBeenCalledWith('/bff/consolidated-protocols/cp1', undefined);
  });

  it('updateConsolidatedProtocol PATCHes the partial meta/overrides body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(undefined));
    vi.stubGlobal('fetch', fetchMock);
    await updateConsolidatedProtocol('cp1', { overrides: { excludedOrderIds: ['o1'] } });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/bff/consolidated-protocols/cp1');
    expect(init).toMatchObject({ method: 'PATCH' });
    expect(JSON.parse(init.body)).toEqual({ overrides: { excludedOrderIds: ['o1'] } });
  });

  it('signConsolidatedProtocol POSTs the receiver signature', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(undefined));
    vi.stubGlobal('fetch', fetchMock);
    await signConsolidatedProtocol('cp1', 'data:image/png;base64,AAA');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/bff/consolidated-protocols/cp1/sign');
    expect(JSON.parse(init.body)).toEqual({ receiverSignaturePng: 'data:image/png;base64,AAA' });
  });

  it('consolidatedProtocolPdfHref points at the PDF endpoint', () => {
    expect(consolidatedProtocolPdfHref('cp1')).toBe('/bff/consolidated-protocols/cp1/pdf');
  });
});

describe('§4.4 "Прати на куриерите" API client', () => {
  it('getConsolidatedCourierRecipients hits GET .../courier-recipients with the date', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse([{ legIndex: 0, name: 'Лег 1', email: 'a@x.bg' }]),
    );
    vi.stubGlobal('fetch', fetchMock);
    const out = await getConsolidatedCourierRecipients('2026-07-22');
    expect(fetchMock).toHaveBeenCalledWith(
      '/bff/consolidated-protocols/courier-recipients?date=2026-07-22',
      undefined,
    );
    expect(out).toEqual([{ legIndex: 0, name: 'Лег 1', email: 'a@x.bg' }]);
  });

  it('sendConsolidatedToCouriers POSTs to .../send-to-couriers with the date and returns the report', async () => {
    const report = { recipients: [], sent: [{ legIndex: 0, email: 'a@x.bg', ok: true }], failed: [] };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(report));
    vi.stubGlobal('fetch', fetchMock);
    const out = await sendConsolidatedToCouriers('2026-07-22');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/bff/consolidated-protocols/send-to-couriers?date=2026-07-22');
    expect(init).toMatchObject({ method: 'POST' });
    expect(out).toEqual(report);
  });
});
