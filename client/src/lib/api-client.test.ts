import { afterEach, describe, expect, it, vi } from 'vitest';
import { getTenantLegal } from './api-client';

afterEach(() => {
  vi.unstubAllGlobals();
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
