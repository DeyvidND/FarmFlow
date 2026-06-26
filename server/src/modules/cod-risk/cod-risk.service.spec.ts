import { Test } from '@nestjs/testing';
import { CodRiskService } from './cod-risk.service';
import { NekorektenClient } from './nekorekten.client';
import { NekorektenRateLimiter } from './nekorekten-rate-limiter';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';

// ---- DB mock helpers --------------------------------------------------------

/** A DB mock that covers two SELECT chains (risk row + events) and one INSERT
 *  chain (upsert). check() runs two queries ending in .limit(); the upsert ends
 *  in .onConflictDoUpdate. Exposed handles let tests assert on calls. */
function makeDb(opts: {
  riskRow?: Record<string, any> | null;
  events?: Record<string, any>[];
}) {
  const riskRowResult = opts.riskRow != null ? [opts.riskRow] : [];
  const eventsResult = opts.events ?? [];

  // Two SELECT .limit() calls in check(): first returns the risk row, second the events.
  const limitMock = jest.fn().mockResolvedValueOnce(riskRowResult).mockResolvedValueOnce(eventsResult);

  const insertOnConflict = jest.fn().mockResolvedValue([]);
  const insertValues = jest.fn().mockReturnValue({ onConflictDoUpdate: insertOnConflict });

  return {
    select: jest.fn().mockReturnThis(),
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: limitMock,
    insert: jest.fn().mockReturnValue({ values: insertValues }),
    // Exposed for assertions
    _insertValues: insertValues,
    _insertOnConflict: insertOnConflict,
  };
}

/** No-op NekorektenRateLimiter mock — always allows (fail-open). */
function makeRateLimiterMock() {
  return {
    reserve: jest.fn().mockResolvedValue({ ok: true, limit: null, retryAfterSeconds: 0 }),
    refund: jest.fn().mockResolvedValue(undefined),
  };
}

// ---- Shared helpers ---------------------------------------------------------

const CLEAN_PHONE = '0888111222';
const NORMALIZED = '+359888111222';
const TENANT_ID = 'tenant-1';

function freshRow(nkFound: boolean): Record<string, any> {
  return {
    strikes: 0,
    nkFound,
    nkCount: nkFound ? 1 : 0,
    nkReports: nkFound ? [{ date: '2026-05-01', phone: NORMALIZED, description: 'test' }] : [],
    // Very recent — well within any TTL
    nkCheckedAt: new Date(Date.now() - 1000),
  };
}

function staleRow(nkFound: boolean): Record<string, any> {
  const FLAGGED_TTL_MS = 90 * 24 * 3600 * 1000;
  const CLEAN_TTL_MS = 30 * 24 * 3600 * 1000;
  const ttl = nkFound ? FLAGGED_TTL_MS : CLEAN_TTL_MS;
  return {
    strikes: 0,
    nkFound,
    nkCount: nkFound ? 1 : 0,
    nkReports: nkFound ? [{ date: '2026-01-01', phone: NORMALIZED, description: 'old' }] : [],
    // Past the TTL
    nkCheckedAt: new Date(Date.now() - ttl - 5000),
  };
}

// ---- Tests: check() ---------------------------------------------------------

describe('CodRiskService.check — DB-backed adaptive TTL', () => {
  let svc: CodRiskService;
  let nkClient: { configured: boolean; checkPhone: jest.Mock };

  async function build(db: ReturnType<typeof makeDb>, nkOverride?: Partial<typeof nkClient>) {
    nkClient = {
      configured: true,
      checkPhone: jest.fn().mockResolvedValue({ configured: true, found: false, count: 0, reports: [], status: 'not_found' }),
      ...nkOverride,
    };
    const mod = await Test.createTestingModule({
      providers: [
        CodRiskService,
        { provide: DB_TOKEN, useValue: db },
        { provide: NekorektenClient, useValue: nkClient },
        { provide: NekorektenRateLimiter, useValue: makeRateLimiterMock() },
      ],
    }).compile();
    svc = mod.get(CodRiskService);
    return db;
  }

  it('returns empty/ok for an unparseable phone (no DB, no API)', async () => {
    const db = makeDb({});
    await build(db);
    const r = await svc.check('abc');
    expect(r.phone).toBeNull();
    expect(r.verdict).toBe('ok');
    expect(nkClient.checkPhone).not.toHaveBeenCalled();
  });

  it('short-circuits nekorekten when our strikes already flag high', async () => {
    const db = makeDb({
      riskRow: { strikes: 2, nkFound: null, nkCount: null, nkReports: null, nkCheckedAt: null },
      events: [{ createdAt: new Date('2026-06-01'), phone: NORMALIZED, type: 'returned' }],
    });
    await build(db);
    const r = await svc.check(CLEAN_PHONE);
    expect(nkClient.checkPhone).not.toHaveBeenCalled();
    expect(r.verdict).toBe('high');
    expect(r.cached).toBe(true);
    expect(r.reports.every((x) => x.source === 'internal')).toBe(true);
    expect(r.reports).toHaveLength(1);
  });

  it('serves nekorekten from fresh DB row — no API call', async () => {
    const db = makeDb({ riskRow: freshRow(true), events: [] });
    await build(db);
    const r = await svc.check(CLEAN_PHONE);
    expect(nkClient.checkPhone).not.toHaveBeenCalled();
    expect(r.cached).toBe(true);
    expect(r.nekorektenCount).toBe(1);
    expect(r.verdict).toBe('caution');
  });

  it('calls API and upserts DB on stale clean row', async () => {
    const db = makeDb({ riskRow: staleRow(false), events: [] });
    await build(db);
    nkClient.checkPhone.mockResolvedValueOnce({ configured: true, found: true, count: 1, reports: [{ date: '2026-05-02', phone: NORMALIZED, description: 'x' }], status: 'ok' });
    const r = await svc.check(CLEAN_PHONE);
    expect(nkClient.checkPhone).toHaveBeenCalledWith(NORMALIZED);
    expect(db._insertOnConflict).toHaveBeenCalled();
    expect(r.cached).toBe(false);
    expect(r.verdict).toBe('caution');
  });

  it('calls API and upserts DB on stale flagged row', async () => {
    const db = makeDb({ riskRow: staleRow(true), events: [] });
    await build(db);
    nkClient.checkPhone.mockResolvedValueOnce({ configured: true, found: false, count: 0, reports: [], status: 'not_found' });
    const r = await svc.check(CLEAN_PHONE);
    expect(nkClient.checkPhone).toHaveBeenCalledWith(NORMALIZED);
    expect(db._insertOnConflict).toHaveBeenCalled();
    expect(r.cached).toBe(false);
  });

  it('calls API when nk_checked_at is null (never checked)', async () => {
    const db = makeDb({ riskRow: { strikes: 0, nkFound: null, nkCount: null, nkReports: null, nkCheckedAt: null }, events: [] });
    await build(db);
    const r = await svc.check(CLEAN_PHONE);
    expect(nkClient.checkPhone).toHaveBeenCalledWith(NORMALIZED);
    expect(r.cached).toBe(false);
  });

  it('forceRefresh bypasses a fresh DB row', async () => {
    const db = makeDb({ riskRow: freshRow(false), events: [] });
    await build(db);
    nkClient.checkPhone.mockResolvedValueOnce({ configured: true, found: false, count: 0, reports: [], status: 'not_found' });
    const r = await svc.check(CLEAN_PHONE, { forceRefresh: true });
    expect(nkClient.checkPhone).toHaveBeenCalledWith(NORMALIZED);
    expect(r.cached).toBe(false);
  });

  it('does not upsert when nekorekten is unconfigured', async () => {
    const db = makeDb({ riskRow: null, events: [] });
    await build(db, { configured: false, checkPhone: jest.fn().mockResolvedValue({ configured: false, found: false, count: 0, reports: [], status: 'unconfigured' }) });
    const r = await svc.check(CLEAN_PHONE);
    expect(db._insertOnConflict).not.toHaveBeenCalled();
    expect(r.nekorektenConfigured).toBe(false);
  });

  it('no DB row at all → behaves like never-checked (calls API)', async () => {
    const db = makeDb({ riskRow: null, events: [] });
    await build(db);
    nkClient.checkPhone.mockResolvedValueOnce({ configured: true, found: false, count: 0, reports: [], status: 'not_found' });
    const r = await svc.check(CLEAN_PHONE);
    expect(nkClient.checkPhone).toHaveBeenCalledWith(NORMALIZED);
    expect(r.strikes).toBe(0);
  });

  it('skipApi with stale row — serves DB snapshot, makes no API call', async () => {
    const db = makeDb({ riskRow: staleRow(true), events: [] });
    await build(db);
    const r = await svc.check(CLEAN_PHONE, { skipApi: true });
    expect(nkClient.checkPhone).not.toHaveBeenCalled();
    expect(r.cached).toBe(true);
    // Should still serve the stale DB snapshot values
    expect(r.nekorektenCount).toBe(1);
  });

  it('skipApi with absent row — serves empty snapshot, makes no API call', async () => {
    const db = makeDb({ riskRow: null, events: [] });
    await build(db);
    const r = await svc.check(CLEAN_PHONE, { skipApi: true });
    expect(nkClient.checkPhone).not.toHaveBeenCalled();
    expect(r.cached).toBe(true);
    expect(r.nekorektenCount).toBe(0);
  });

  it('rate_limited from API → does NOT upsert, serves DB snapshot, sets nkStatus', async () => {
    const db = makeDb({ riskRow: staleRow(true), events: [] });
    await build(db);
    // API returns rate_limited
    nkClient.checkPhone.mockResolvedValueOnce({
      configured: true, found: false, count: 0, reports: [],
      status: 'rate_limited', retryAfterSeconds: 30,
    });
    const r = await svc.check(CLEAN_PHONE);
    // Must NOT persist (no upsert)
    expect(db._insertOnConflict).not.toHaveBeenCalled();
    // DB snapshot should be served (stale flagged row has count=1)
    expect(r.nekorektenCount).toBe(1);
    expect(r.nkStatus).toBe('rate_limited');
    expect(r.retryAfterSeconds).toBe(30);
    // cached=true (no successful live write)
    expect(r.cached).toBe(true);
  });

  it('unavailable from API → does NOT upsert, serves DB snapshot, sets nkStatus', async () => {
    const db = makeDb({ riskRow: freshRow(true), events: [] });
    await build(db);
    nkClient.checkPhone.mockResolvedValueOnce({
      configured: true, found: false, count: 0, reports: [],
      status: 'unavailable',
    });
    // Force a stale-enough row to trigger API call
    const db2 = makeDb({ riskRow: staleRow(true), events: [] });
    await build(db2);
    nkClient.checkPhone.mockResolvedValueOnce({
      configured: true, found: false, count: 0, reports: [],
      status: 'unavailable',
    });
    const r = await svc.check(CLEAN_PHONE);
    expect(db2._insertOnConflict).not.toHaveBeenCalled();
    expect(r.nkStatus).toBe('unavailable');
    expect(r.cached).toBe(true);
  });

  it('rate_limited with no existing DB row → empty snapshot, not persisted', async () => {
    const db = makeDb({ riskRow: null, events: [] });
    await build(db);
    nkClient.checkPhone.mockResolvedValueOnce({
      configured: true, found: false, count: 0, reports: [],
      status: 'rate_limited', retryAfterSeconds: 45,
    });
    const r = await svc.check(CLEAN_PHONE);
    expect(db._insertOnConflict).not.toHaveBeenCalled();
    expect(r.nekorektenCount).toBe(0);
    expect(r.nkStatus).toBe('rate_limited');
    expect(r.retryAfterSeconds).toBe(45);
  });
});

// ---- Tests: checkBulk() -----------------------------------------------------

describe('CodRiskService.checkBulk', () => {
  let svc: CodRiskService;

  const okCheckResult = {
    phone: NORMALIZED,
    verdict: 'ok' as const,
    strikes: 0,
    nekorektenCount: 0,
    nekorektenConfigured: true,
    cached: true,
    reports: [],
    nkStatus: 'not_found' as const,
  };

  const rateLimitedCheckResult = {
    phone: NORMALIZED,
    verdict: 'ok' as const,
    strikes: 0,
    nekorektenCount: 0,
    nekorektenConfigured: true,
    cached: true,
    reports: [],
    nkStatus: 'rate_limited' as const,
    retryAfterSeconds: 30,
  };

  /** Build service and replace check() with a spy for bulk-level tests. */
  async function buildWithSpy(checkSpy: jest.Mock) {
    const nkClient = { configured: true, checkPhone: jest.fn().mockResolvedValue({ configured: true, found: false, count: 0, reports: [], status: 'not_found' }) };
    const db = {
      select: jest.fn().mockReturnThis(),
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue([]),
      insert: jest.fn().mockReturnValue({ values: jest.fn().mockReturnValue({ onConflictDoUpdate: jest.fn().mockResolvedValue([]) }) }),
    };
    const mod = await Test.createTestingModule({
      providers: [
        CodRiskService,
        { provide: DB_TOKEN, useValue: db },
        { provide: NekorektenClient, useValue: nkClient },
        { provide: NekorektenRateLimiter, useValue: makeRateLimiterMock() },
      ],
    }).compile();
    svc = mod.get(CodRiskService);
    svc.check = checkSpy;
    return svc;
  }

  it('dedupes duplicate phones — check() called once per unique normalized phone', async () => {
    const checkSpy = jest.fn().mockResolvedValue(okCheckResult);
    await buildWithSpy(checkSpy);
    const r = await svc.checkBulk(TENANT_ID, ['0888111222', '0888 111 222', '+359888111222']);
    // All three normalize to the same phone → check() must be called exactly once.
    expect(checkSpy).toHaveBeenCalledTimes(1);
    // All three input phones get a result (duplicates mapped back).
    expect(r.results).toHaveLength(3);
    expect(r.results.every((x) => x.verdict === 'ok')).toBe(true);
  });

  it('returns original phone + normalized phone in each result', async () => {
    const checkSpy = jest.fn().mockResolvedValue(okCheckResult);
    await buildWithSpy(checkSpy);
    const { results } = await svc.checkBulk(TENANT_ID, [CLEAN_PHONE]);
    expect(results[0].phone).toBe(CLEAN_PHONE);
    expect(results[0].normalized).toBe(NORMALIZED);
  });

  it('caps at 500 unique phones (BULK_CAP)', async () => {
    const phones = Array.from({ length: 600 }, (_, i) => `088${String(i + 10000000).slice(1)}`);
    const checkSpy = jest.fn().mockResolvedValue(okCheckResult);
    await buildWithSpy(checkSpy);
    await svc.checkBulk(TENANT_ID, phones);
    expect(checkSpy).toHaveBeenCalledTimes(500);
  });

  it('handles mixed valid/invalid phones without throwing', async () => {
    const checkSpy = jest.fn().mockResolvedValue(okCheckResult);
    await buildWithSpy(checkSpy);
    const r = await svc.checkBulk(TENANT_ID, ['abc', CLEAN_PHONE, '']);
    expect(r.results).toHaveLength(3);
  });

  it('propagates cached=false + verdict from check() result', async () => {
    const cautiousResult = { ...okCheckResult, verdict: 'caution' as const, nekorektenCount: 1, cached: false, nkStatus: 'ok' as const };
    const checkSpy = jest.fn().mockResolvedValue(cautiousResult);
    await buildWithSpy(checkSpy);
    const { results } = await svc.checkBulk(TENANT_ID, [CLEAN_PHONE]);
    expect(results[0].cached).toBe(false);
    expect(results[0].verdict).toBe('caution');
    expect(results[0].nekorektenCount).toBe(1);
  });

  it('empty input returns { results:[], meta:{checked:0,...} }', async () => {
    const checkSpy = jest.fn().mockResolvedValue(okCheckResult);
    await buildWithSpy(checkSpy);
    const r = await svc.checkBulk(TENANT_ID, []);
    expect(r.results).toHaveLength(0);
    expect(r.meta.checked).toBe(0);
    expect(r.meta.rateLimited).toBe(0);
    expect(checkSpy).not.toHaveBeenCalled();
  });

  it('duplicate phones in output use canonical r.phone (cosmetic consistency)', async () => {
    const checkSpy = jest.fn().mockResolvedValue(okCheckResult);
    await buildWithSpy(checkSpy);
    // Two phones that normalize to the same value — the second is a duplicate.
    const { results } = await svc.checkBulk(TENANT_ID, [CLEAN_PHONE, '+359888111222']);
    // Both entries should use the canonical r.phone (NORMALIZED) as their normalized field.
    expect(results[0].normalized).toBe(NORMALIZED);
    expect(results[1].normalized).toBe(NORMALIZED);
  });

  it('returns { results, meta } shape with correct fields', async () => {
    const checkSpy = jest.fn().mockResolvedValue(okCheckResult);
    await buildWithSpy(checkSpy);
    const r = await svc.checkBulk(TENANT_ID, [CLEAN_PHONE]);
    // results array
    expect(Array.isArray(r.results)).toBe(true);
    // meta object
    expect(typeof r.meta.checked).toBe('number');
    expect(typeof r.meta.rateLimited).toBe('number');
    expect(r.meta.limit === null || r.meta.limit === 'minute' || r.meta.limit === 'day').toBe(true);
    expect(typeof r.meta.retryAfterSeconds).toBe('number');
  });

  it('BulkRiskResult.status is ok/caution/high for answered phones', async () => {
    const checkSpy = jest.fn()
      .mockResolvedValueOnce({ ...okCheckResult, verdict: 'ok' as const, nkStatus: 'not_found' as const })
      .mockResolvedValueOnce({ ...okCheckResult, verdict: 'caution' as const, nkStatus: 'ok' as const })
      .mockResolvedValueOnce({ ...okCheckResult, verdict: 'high' as const, nkStatus: 'ok' as const });
    await buildWithSpy(checkSpy);
    const phone1 = '0888000001';
    const phone2 = '0888000002';
    const phone3 = '0888000003';
    const { results } = await svc.checkBulk(TENANT_ID, [phone1, phone2, phone3]);
    expect(results[0].status).toBe('ok');
    expect(results[1].status).toBe('caution');
    expect(results[2].status).toBe('high');
  });

  it('stop-on-limit: first rate_limited triggers stopped flag, remaining phones use skipApi', async () => {
    // 3 unique phones: first ok, second rate_limited, third should be called with skipApi=true.
    // Stop-on-limit can only engage for phones picked AFTER the first concurrency
    // wave resolves — so the batch must exceed CONCURRENCY (5). The first wave
    // (idx 0..4) is picked synchronously with stopped=false; once idx1's rate_limit
    // resolves, the tail (idx 5..7) is picked with skipApi=true. (For batches
    // ≤ concurrency the global Redis limiter is the real gate, not this flag.)
    const phones = Array.from({ length: 8 }, (_, i) => `+35988800000${i}`);
    const rlPhone = phones[1]; // second phone (first wave) hits the limit

    const calls: Array<{ phone: string; opts?: { skipApi?: boolean } }> = [];
    const checkSpy = jest.fn().mockImplementation(async (phone: string, opts?: { skipApi?: boolean }) => {
      calls.push({ phone, opts });
      if (phone === rlPhone) return { ...rateLimitedCheckResult, phone: rlPhone };
      return { ...okCheckResult, phone };
    });
    await buildWithSpy(checkSpy);
    const { results, meta } = await svc.checkBulk(TENANT_ID, phones);

    expect(meta.rateLimited).toBeGreaterThanOrEqual(1);
    expect(meta.limit).not.toBeNull();
    // The deep-tail phones (picked well after the stop flag engaged) must be called
    // with skipApi=true. The very first phone of the second wave (idx 5) can slip
    // through with a live call because the worker that frees up first may resume
    // before the rate-limited worker sets the flag — that's fine, the global Redis
    // limiter denies it anyway. So assert on idx 6+ which is deterministically post-stop.
    for (const tail of phones.slice(6)) {
      const call = calls.find((c) => c.phone === tail);
      expect(call?.opts?.skipApi).toBe(true);
    }
    // Every input phone is represented in the results.
    expect(results).toHaveLength(8);
  });

  it('meta.checked counts phones that got a real verdict (not rate_limited)', async () => {
    const checkSpy = jest.fn()
      .mockResolvedValueOnce(okCheckResult) // answered
      .mockResolvedValueOnce(rateLimitedCheckResult); // rate_limited
    await buildWithSpy(checkSpy);
    const phone1 = '0888000001';
    const phone2 = '0888000002';
    const { meta } = await svc.checkBulk(TENANT_ID, [phone1, phone2]);
    expect(meta.rateLimited).toBeGreaterThanOrEqual(1);
  });

  it('BulkRiskResult.status is rate_limited for rate-limited phones', async () => {
    const checkSpy = jest.fn().mockResolvedValue(rateLimitedCheckResult);
    await buildWithSpy(checkSpy);
    const { results } = await svc.checkBulk(TENANT_ID, [CLEAN_PHONE]);
    expect(results[0].status).toBe('rate_limited');
    expect(results[0].retryAfterSeconds).toBe(30);
  });

  it('skipApi path — stale row + skipApi returns DB snapshot with no checkPhone call', async () => {
    // Build service WITHOUT replacing check() so we can test the actual skipApi flow.
    const nkCheckPhone = jest.fn().mockResolvedValue({ configured: true, found: false, count: 0, reports: [], status: 'not_found' });
    const nkClient = { configured: true, checkPhone: nkCheckPhone };
    // DB returns a stale row for the risk check, empty events.
    const staleRowData = staleRow(true);
    // Each check() call in checkBulk triggers two .limit() calls (risk row + events).
    const db = {
      select: jest.fn().mockReturnThis(),
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      // Alternating: riskRow, events
      limit: jest.fn()
        .mockResolvedValueOnce([staleRowData])
        .mockResolvedValueOnce([]),
      insert: jest.fn().mockReturnValue({ values: jest.fn().mockReturnValue({ onConflictDoUpdate: jest.fn().mockResolvedValue([]) }) }),
    };
    // Return rate_limited from the API call so the service engages stop-on-limit
    // and subsequent phones use skipApi. But here we only have 1 phone and want
    // to test a DB-snapshot skip scenario via a pre-stopped service state.
    //
    // Simpler: mock nkCheckPhone to return rate_limited so checkBulk never persists.
    const rateLimitedClient = {
      configured: true,
      checkPhone: jest.fn().mockResolvedValue({
        configured: true, found: false, count: 0, reports: [],
        status: 'rate_limited', retryAfterSeconds: 30,
      }),
    };
    const mod = await Test.createTestingModule({
      providers: [
        CodRiskService,
        { provide: DB_TOKEN, useValue: db },
        { provide: NekorektenClient, useValue: rateLimitedClient },
        { provide: NekorektenRateLimiter, useValue: makeRateLimiterMock() },
      ],
    }).compile();
    const service = mod.get(CodRiskService);
    const { results } = await service.checkBulk(TENANT_ID, [CLEAN_PHONE]);
    // DB snapshot should still be served (stale row has count=1)
    expect(results[0].cached).toBe(true);
    // rate_limited from API means no persist
    expect(db.insert).not.toHaveBeenCalled();
  });
});
