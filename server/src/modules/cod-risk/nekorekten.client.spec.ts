import { NekorektenClient } from './nekorekten.client';
import { NekorektenRateLimiter } from './nekorekten-rate-limiter';

// Minimal ConfigService mock.
const cfg = (key: string) => ({ get: () => key }) as never;

// Minimal limiter mocks.
function makeLimiter(reserveResult: Awaited<ReturnType<NekorektenRateLimiter['reserve']>>) {
  return {
    reserve: jest.fn().mockResolvedValue(reserveResult),
    refund: jest.fn().mockResolvedValue(undefined),
  } as unknown as NekorektenRateLimiter;
}

const allowLimiter = () => makeLimiter({ ok: true, limit: null, retryAfterSeconds: 0 });
const denyMinuteLimiter = () => makeLimiter({ ok: false, limit: 'minute', retryAfterSeconds: 30 });

describe('NekorektenClient (no key)', () => {
  it('checkPhone returns unconfigured + empty, never throws', async () => {
    const limiter = allowLimiter();
    const c = new NekorektenClient(cfg(''), limiter);
    const out = await c.checkPhone('+359888123456');
    expect(out.configured).toBe(false);
    expect(out.status).toBe('unconfigured');
    expect(out.count).toBe(0);
    // No reserve() when unconfigured — no reason to hit the limiter.
    expect(limiter.reserve).not.toHaveBeenCalled();
  });

  it('reportPhone throws a clear error when unconfigured', async () => {
    const c = new NekorektenClient(cfg(''), allowLimiter());
    await expect(c.reportPhone({ phone: '+359888123456', text: 'x' })).rejects.toThrow('nekorekten');
  });
});

describe('NekorektenClient — rate-limit guard', () => {
  it('limiter deny → returns rate_limited WITHOUT fetching', async () => {
    const limiter = denyMinuteLimiter();
    const c = new NekorektenClient(cfg('test-key'), limiter);

    // We patch global fetch to assert it is never called.
    const fetchSpy = jest.spyOn(global, 'fetch');

    const out = await c.checkPhone('+359888123456');

    expect(limiter.reserve).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(out.status).toBe('rate_limited');
    expect(out.retryAfterSeconds).toBe(30);
    expect(out.configured).toBe(true);
    expect(out.count).toBe(0);

    fetchSpy.mockRestore();
  });

  it('HTTP 429 → rate_limited, reservation kept (no refund), reads Retry-After', async () => {
    const limiter = allowLimiter();
    const c = new NekorektenClient(cfg('test-key'), limiter);

    jest.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 429,
      headers: { get: (h: string) => (h === 'Retry-After' ? '45' : null) },
    } as any);

    const out = await c.checkPhone('+359888111222');

    expect(out.status).toBe('rate_limited');
    expect(out.retryAfterSeconds).toBe(45);
    // Must NOT refund — reservation was consumed (we did hit their limit).
    expect(limiter.refund).not.toHaveBeenCalled();

    jest.restoreAllMocks();
  });

  it('HTTP 429 without Retry-After defaults to seconds-to-next-minute', async () => {
    const limiter = allowLimiter();
    const c = new NekorektenClient(cfg('test-key'), limiter);

    jest.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 429,
      headers: { get: () => null },
    } as any);

    const out = await c.checkPhone('+359888111222');
    expect(out.status).toBe('rate_limited');
    expect(out.retryAfterSeconds).toBeGreaterThan(0);
    expect(out.retryAfterSeconds).toBeLessThanOrEqual(60);

    jest.restoreAllMocks();
  });

  it('5xx → unavailable + refund called', async () => {
    const limiter = allowLimiter();
    const c = new NekorektenClient(cfg('test-key'), limiter);

    jest.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 503,
      headers: { get: () => null },
    } as any);

    const out = await c.checkPhone('+359888111222');
    expect(out.status).toBe('unavailable');
    expect(limiter.refund).toHaveBeenCalledTimes(1);

    jest.restoreAllMocks();
  });

  it('network error → unavailable + refund called', async () => {
    const limiter = allowLimiter();
    const c = new NekorektenClient(cfg('test-key'), limiter);

    jest.spyOn(global, 'fetch').mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const out = await c.checkPhone('+359888111222');
    expect(out.status).toBe('unavailable');
    expect(limiter.refund).toHaveBeenCalledTimes(1);

    jest.restoreAllMocks();
  });

  it('200 with reports → status ok, count>0', async () => {
    const limiter = allowLimiter();
    const c = new NekorektenClient(cfg('test-key'), limiter);

    jest.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => [{ phone: '+359888111222', text: 'bad payer', createdAt: '2026-01-01' }],
    } as any);

    const out = await c.checkPhone('+359888111222');
    expect(out.status).toBe('ok');
    expect(out.count).toBe(1);
    expect(out.found).toBe(true);
    expect(limiter.refund).not.toHaveBeenCalled();

    jest.restoreAllMocks();
  });

  it('200 with empty reports → status not_found, count=0', async () => {
    const limiter = allowLimiter();
    const c = new NekorektenClient(cfg('test-key'), limiter);

    jest.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => [],
    } as any);

    const out = await c.checkPhone('+359888111222');
    expect(out.status).toBe('not_found');
    expect(out.count).toBe(0);
    expect(out.found).toBe(false);
    expect(limiter.refund).not.toHaveBeenCalled();

    jest.restoreAllMocks();
  });
});
